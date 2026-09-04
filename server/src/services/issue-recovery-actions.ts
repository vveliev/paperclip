import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRecoveryActions } from "@paperclipai/db";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";

const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];
const MAX_UPSERT_RETRIES = 3;

// A recovery action with no timeoutAt is permanent by construction: nothing
// ever re-evaluates it, so a fixed underlying fault leaves the flag (and the
// issue it holds) stuck forever (BLA-1074). Every action gets a default
// expiry unless the caller passes an explicit `timeoutAt` (including
// `null`, which opts a specific action out). `escalated` actions are exempt
// (see isExpiredActiveRow) because that status means a human already owns
// it; auto-clearing would silently take back a deliberate hand-off.
const DEFAULT_RECOVERY_ACTION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

type IssueRecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

function asDatabaseDate(value: string | Date | null) {
  return typeof value === "string" ? new Date(value) : value;
}

// `undefined` means "caller didn't specify a timeout" -> apply the default.
// An explicit `null` (or a concrete Date) is a deliberate choice and passes
// through unchanged.
function defaultTimeoutAt(explicit: Date | null | undefined, now: Date): Date | null {
  if (explicit !== undefined) return explicit;
  return new Date(now.getTime() + DEFAULT_RECOVERY_ACTION_TIMEOUT_MS);
}

// Only `active` rows expire on their own. `escalated` means a human already
// owns the flag explicitly (see the recovery-budget-exhaustion branch below,
// which always sets timeoutAt: null when it escalates) - auto-clearing that
// would silently undo a deliberate hand-off instead of just forcing a
// cheap re-check.
function isExpiredActiveRow(row: IssueRecoveryActionRow, now: Date): boolean {
  if (row.status !== "active" || row.timeoutAt == null) return false;
  const timeoutAt = asDatabaseDate(row.timeoutAt);
  return timeoutAt != null && timeoutAt.getTime() <= now.getTime();
}

function isRecoveryBudgetExhausted(evidence: Record<string, unknown>) {
  const budget = evidence.recoveryBudget;
  return Boolean(
    budget &&
      typeof budget === "object" &&
      !Array.isArray(budget) &&
      (budget as Record<string, unknown>).state === "exhausted",
  );
}

export type UpsertIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId?: string | null;
  kind: IssueRecoveryActionKind;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  cause: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  /** Evidence written only when this upsert creates a new action row. */
  evidenceOnCreate?: Record<string, unknown>;
  nextAction: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
  attemptCount?: number;
  // When true, a change of (cause, fingerprint) does not overwrite the active
  // action in place. The service resolves the prior action and inserts a new
  // one. The new failure then gets a distinct recovery identity and a fresh
  // operator notice, and the prior identity stays as a resolved record.
  supersedeOnIdentityChange?: boolean;
  // Rollout compatibility for active pre-policy actions. Refresh their
  // evidence/attempt metadata without silently changing the recorded owner or
  // the wake/monitor contract that made that owner authoritative.
  preserveExistingOwner?: boolean;
};

export type ResolveIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  kind?: IssueRecoveryActionKind | null;
  cause?: string | null;
  fingerprint?: string | null;
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
};

function toReadModel(row: IssueRecoveryActionRow): IssueRecoveryAction {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceIssueId: row.sourceIssueId,
    recoveryIssueId: row.recoveryIssueId,
    kind: row.kind as IssueRecoveryAction["kind"],
    status: row.status as IssueRecoveryAction["status"],
    ownerType: row.ownerType as IssueRecoveryAction["ownerType"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    previousOwnerAgentId: row.previousOwnerAgentId,
    returnOwnerAgentId: row.returnOwnerAgentId,
    cause: row.cause,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    nextAction: row.nextAction,
    wakePolicy: row.wakePolicy,
    monitorPolicy: row.monitorPolicy,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    timeoutAt: row.timeoutAt,
    lastAttemptAt: row.lastAttemptAt,
    outcome: row.outcome as IssueRecoveryAction["outcome"],
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueRecoveryActionConflict(error: unknown) {
  const maybe = error as { code?: string; constraint?: string; message?: string } | null;
  return Boolean(
    maybe &&
      maybe.code === "23505" &&
      (
        maybe.constraint === "issue_recovery_actions_active_source_uq" ||
        maybe.constraint === "issue_recovery_actions_active_fingerprint_uq" ||
        typeof maybe.message === "string" && (
          maybe.message.includes("issue_recovery_actions_active_source_uq") ||
          maybe.message.includes("issue_recovery_actions_active_fingerprint_uq")
        )
      ),
  );
}

export function issueRecoveryActionService(db: Db) {
  const upsertQueues = new Map<string, Promise<void>>();

  async function runExclusiveUpsert<T>(
    input: UpsertIssueRecoveryActionInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.companyId}:${input.sourceIssueId}`;
    const previous = upsertQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    upsertQueues.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (upsertQueues.get(key) === next) {
        upsertQueues.delete(key);
      }
    }
  }

  // Lazily clears a stale `active` row when it's read past its timeoutAt,
  // instead of leaving it to silently keep gating the issue. The WHERE guard
  // makes this idempotent under a race: if another writer already resolved
  // or refreshed the row, this update matches zero rows and the caller falls
  // back to treating the (now-changed) row as not this expired snapshot.
  async function expireRow(
    dbOrTx: DbOrTransaction,
    row: IssueRecoveryActionRow,
    now: Date,
  ): Promise<IssueRecoveryActionRow | null> {
    const [expired] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: "resolved",
        outcome: "expired",
        resolutionNote: "Recovery action expired without being re-confirmed; treated as cleared so the issue can be picked up again.",
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(eq(issueRecoveryActions.id, row.id), eq(issueRecoveryActions.status, "active")))
      .returning();
    return expired ?? null;
  }

  async function getActiveForIssue(
    companyId: string,
    sourceIssueId: string,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const row = await dbOrTx
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const now = new Date();
    if (isExpiredActiveRow(row, now)) {
      await expireRow(dbOrTx, row, now);
      return null;
    }
    return toReadModel(row);
  }

  async function listActiveForIssues(companyId: string, sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, IssueRecoveryAction>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const now = new Date();
    const expired = rows.filter((row) => isExpiredActiveRow(row, now));
    if (expired.length > 0) {
      await Promise.all(expired.map((row) => expireRow(db, row, now)));
    }
    const result = new Map<string, IssueRecoveryAction>();
    for (const row of rows) {
      if (isExpiredActiveRow(row, now)) continue;
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, toReadModel(row));
    }
    return result;
  }

  async function retryUpsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    retryCount: number,
    error?: unknown,
  ): Promise<IssueRecoveryAction> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1);
  }

  function buildInsertValues(
    input: UpsertIssueRecoveryActionInput,
    ownerType: IssueRecoveryActionOwnerType,
    now: Date,
  ) {
    return {
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      recoveryIssueId: input.recoveryIssueId ?? null,
      kind: input.kind,
      status: "active" as const,
      ownerType,
      ownerAgentId: input.ownerAgentId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      previousOwnerAgentId: input.previousOwnerAgentId ?? null,
      returnOwnerAgentId: input.returnOwnerAgentId ?? null,
      cause: input.cause,
      fingerprint: input.fingerprint,
      evidence: {
        ...(input.evidence ?? {}),
        ...(input.evidenceOnCreate ?? {}),
      },
      nextAction: input.nextAction,
      wakePolicy: input.wakePolicy ?? null,
      monitorPolicy: input.monitorPolicy ?? null,
      attemptCount: input.attemptCount ?? 1,
      maxAttempts: input.maxAttempts ?? null,
      timeoutAt: defaultTimeoutAt(input.timeoutAt, now),
      lastAttemptAt: input.lastAttemptAt ?? now,
    };
  }

  // Resolve the prior active action, then insert a new one in one transaction.
  // The prior identity stays as a cancelled record and the new failure gets a
  // fresh action row with its own id. The partial unique index on the active
  // status stays satisfied because only the new row is active at commit.
  async function supersedePriorAndInsert(
    input: UpsertIssueRecoveryActionInput,
    priorActionId: string,
    ownerType: IssueRecoveryActionOwnerType,
    now: Date,
    retryCount: number,
  ): Promise<IssueRecoveryAction> {
    try {
      const created = await db.transaction(async (tx) => {
        const [superseded] = await tx
          .update(issueRecoveryActions)
          .set({
            status: "cancelled",
            outcome: "cancelled",
            resolutionNote: "A new failure with a different identity superseded this recovery action.",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(issueRecoveryActions.id, priorActionId),
              inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
            ),
          )
          .returning();
        // Another writer resolved the prior action first. Abort and retry the
        // whole upsert so the retry reads the current active state.
        if (!superseded) return null;
        const [row] = await tx
          .insert(issueRecoveryActions)
          .values(buildInsertValues(input, ownerType, now))
          .returning();
        return row ?? null;
      });
      if (!created) return retryUpsertSourceScoped(input, retryCount);
      return toReadModel(created);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
  ): Promise<IssueRecoveryAction> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId);
    const now = new Date();
    const ownerType = input.ownerType ?? (input.ownerAgentId ? "agent" : "board");
    if (existing) {
      // A distinct failure identity must not overwrite the active action of a
      // prior identity. Resolve the prior action and insert a new one, so the
      // operator gets a new notice for the new failure.
      if (
        input.supersedeOnIdentityChange &&
        (existing.cause !== input.cause || existing.fingerprint !== input.fingerprint)
      ) {
        return supersedePriorAndInsert(input, existing.id, ownerType, now, retryCount);
      }
      // `maxAttempts` is an execution budget, not display metadata. Once the
      // same recovery identity consumes it, retain one inspectable board-owned
      // action but remove every automatic wake/monitor path. Repeated sweep or
      // finalizer writes then become idempotent instead of silently advancing
      // beyond the advertised cap. A distinct identity can still supersede the
      // exhausted action through the branch above.
      if (isRecoveryBudgetExhausted(existing.evidence ?? {})) {
        return existing;
      }
      const nextAttemptCount =
        input.attemptCount ?? existing.attemptCount + 1;
      const effectiveMaxAttempts = input.preserveExistingOwner
        ? existing.maxAttempts
        : input.maxAttempts === undefined
          ? existing.maxAttempts
          : input.maxAttempts;
      if (
        effectiveMaxAttempts !== null &&
        nextAttemptCount >= effectiveMaxAttempts
      ) {
        const attemptsUsed = Math.max(
          existing.attemptCount,
          Math.min(nextAttemptCount, effectiveMaxAttempts),
        );
        const [exhausted] = await db
          .update(issueRecoveryActions)
          .set({
            status: "escalated",
            ownerType: "board",
            ownerAgentId: null,
            ownerUserId: null,
            previousOwnerAgentId:
              existing.ownerAgentId ?? existing.previousOwnerAgentId,
            returnOwnerAgentId:
              input.returnOwnerAgentId ??
              existing.returnOwnerAgentId ??
              existing.ownerAgentId,
            evidence: {
              ...(existing.evidence ?? {}),
              ...(input.evidence ?? {}),
              recoveryBudget: {
                state: "exhausted",
                attemptsUsed,
                maxAttempts: effectiveMaxAttempts,
                exhaustedAt: now.toISOString(),
                cause: existing.cause,
                fingerprint: existing.fingerprint,
              },
            },
            nextAction:
              `Automatic recovery exhausted after ${attemptsUsed}/${effectiveMaxAttempts} attempts. ` +
              "Review the infrastructure failure and explicitly choose a replacement run or provider configuration.",
            wakePolicy: null,
            monitorPolicy: null,
            attemptCount: attemptsUsed,
            maxAttempts: effectiveMaxAttempts,
            timeoutAt: null,
            lastAttemptAt: input.lastAttemptAt ?? now,
            outcome: "escalated",
            resolutionNote: null,
            resolvedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issueRecoveryActions.id, existing.id),
              inArray(issueRecoveryActions.status, [
                ...ACTIVE_RECOVERY_ACTION_STATUSES,
              ]),
            ),
          )
          .returning();
        if (!exhausted) {
          return retryUpsertSourceScoped(input, retryCount);
        }
        return toReadModel(exhausted);
      }
      const [updated] = await db
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.preserveExistingOwner
            ? existing.recoveryIssueId
            : input.recoveryIssueId ?? null,
          kind: input.preserveExistingOwner ? existing.kind : input.kind,
          status: input.preserveExistingOwner ? existing.status : "active",
          ownerType: input.preserveExistingOwner ? existing.ownerType : ownerType,
          ownerAgentId: input.preserveExistingOwner
            ? existing.ownerAgentId
            : input.ownerAgentId ?? null,
          ownerUserId: input.preserveExistingOwner
            ? existing.ownerUserId
            : input.ownerUserId ?? null,
          previousOwnerAgentId: input.preserveExistingOwner
            ? existing.previousOwnerAgentId
            : input.previousOwnerAgentId ?? existing.previousOwnerAgentId,
          returnOwnerAgentId: input.preserveExistingOwner
            ? existing.returnOwnerAgentId
            : input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.preserveExistingOwner ? existing.cause : input.cause,
          fingerprint: input.preserveExistingOwner ? existing.fingerprint : input.fingerprint,
          evidence: input.preserveExistingOwner
            ? {
              ...(existing.evidence ?? {}),
              ...(input.evidence ?? {}),
            }
            : input.evidence ?? existing.evidence,
          nextAction: input.preserveExistingOwner ? existing.nextAction : input.nextAction,
          wakePolicy: input.preserveExistingOwner
            ? existing.wakePolicy
            : input.wakePolicy ?? null,
          monitorPolicy: input.preserveExistingOwner
            ? existing.monitorPolicy
            : input.monitorPolicy ?? null,
          attemptCount: nextAttemptCount,
          maxAttempts: input.preserveExistingOwner
            ? existing.maxAttempts
            : input.maxAttempts === undefined
              ? existing.maxAttempts
              : input.maxAttempts,
          timeoutAt: input.preserveExistingOwner
            ? asDatabaseDate(existing.timeoutAt)
            : defaultTimeoutAt(input.timeoutAt, now),
          lastAttemptAt: input.preserveExistingOwner
            ? asDatabaseDate(existing.lastAttemptAt)
            : input.lastAttemptAt ?? now,
          outcome: input.preserveExistingOwner ? existing.outcome : null,
          resolutionNote: input.preserveExistingOwner ? existing.resolutionNote : null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueRecoveryActions.id, existing.id),
            inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          ),
        )
        .returning();
      if (!updated) {
        return retryUpsertSourceScoped(input, retryCount);
      }
      return toReadModel(updated!);
    }

    try {
      const [created] = await db
        .insert(issueRecoveryActions)
        .values(buildInsertValues(input, ownerType, now))
        .returning();
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
  ): Promise<IssueRecoveryAction> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input));
  }

  async function resolveActiveForIssue(
    input: ResolveIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const predicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      predicates.push(eq(issueRecoveryActions.id, input.actionId));
    }
    if (input.kind) {
      predicates.push(eq(issueRecoveryActions.kind, input.kind));
    }
    if (input.cause) {
      predicates.push(eq(issueRecoveryActions.cause, input.cause));
    }
    if (input.fingerprint) {
      predicates.push(eq(issueRecoveryActions.fingerprint, input.fingerprint));
    }

    const [updated] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(...predicates))
      .returning();

    return updated ? toReadModel(updated) : null;
  }

  return {
    getActiveForIssue,
    listActiveForIssues,
    resolveActiveForIssue,
    upsertSourceScoped,
  };
}
