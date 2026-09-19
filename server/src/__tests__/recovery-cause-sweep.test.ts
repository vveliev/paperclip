import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issueComments,
  issueLabels,
  issueRecoveryActions,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery-cause sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweepRecoveryActionsForResolvedPlatformCauses", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-cause-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(overrides: { platformIssueStatus?: "done" | "todo"; labelName?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceIssueId = randomUUID();
    const platformIssueId = randomUUID();
    const prefix = `RC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Cause Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Stuck on workspace validation",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${prefix}-1`,
      },
      {
        id: platformIssueId,
        companyId,
        title: "Fix workspace validation bug",
        status: overrides.platformIssueStatus ?? "done",
        priority: "high",
        issueNumber: 2,
        identifier: `${prefix}-2`,
        completedAt: new Date(),
      },
    ]);

    const labelId = randomUUID();
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: overrides.labelName ?? "recovery-cause:workspace_validation_failed",
      color: "#ff0000",
    });
    await db.insert(issueLabels).values({
      issueId: platformIssueId,
      labelId,
      companyId,
    });

    return { companyId, agentId, sourceIssueId, platformIssueId, prefix };
  }

  it("clears an active recovery action once its named platform cause closes done", async () => {
    const { companyId, agentId, sourceIssueId, platformIssueId, prefix } = await seed();
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const recovery = recoveryService(db, { enqueueWakeup });
    const recoveryActionsSvc = issueRecoveryActionService(db);

    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace-validation:fingerprint",
      nextAction: "Wait for the platform fix.",
    });

    const result = await recovery.sweepRecoveryActionsForResolvedPlatformCauses();

    expect(result.cleared).toBe(1);
    expect(result.woken).toBe(1);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        recoveryActionId: action.id,
        sourceIssueId,
        cause: "workspace_validation_failed",
        resolvedByIssueId: platformIssueId,
        resolvedByIssueIdentifier: `${prefix}-2`,
      }),
    ]);

    const [row] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(row).toMatchObject({ status: "resolved", outcome: "restored" });

    const [audit] = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.recovery_cause_swept"));
    expect(audit?.details).toMatchObject({ sourceIssueId, resolvedByIssueId: platformIssueId });

    const [comment] = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssueId));
    expect(comment?.body).toContain(`${prefix}-2`);

    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "issue_recovery_cause_resolved" }));
  });

  it("does nothing when no issue is labeled as the cause", async () => {
    const { companyId, sourceIssueId } = await seed({ labelName: "recovery-cause:some_other_cause" });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const recoveryActionsSvc = issueRecoveryActionService(db);

    await recoveryActionsSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: null,
      cause: "workspace_validation_failed",
      fingerprint: "workspace-validation:fingerprint",
      nextAction: "Wait for the platform fix.",
    });

    const result = await recovery.sweepRecoveryActionsForResolvedPlatformCauses();

    expect(result).toEqual({ candidates: [], cleared: 0, woken: 0, failed: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not clear when the labeled platform issue is still open", async () => {
    const { companyId, sourceIssueId } = await seed({ platformIssueStatus: "todo" });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const recoveryActionsSvc = issueRecoveryActionService(db);

    await recoveryActionsSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: null,
      cause: "workspace_validation_failed",
      fingerprint: "workspace-validation:fingerprint",
      nextAction: "Wait for the platform fix.",
    });

    const result = await recovery.sweepRecoveryActionsForResolvedPlatformCauses();
    expect(result.cleared).toBe(0);
  });

  it("does not clear an escalated action — a human already owns it", async () => {
    const { companyId, sourceIssueId } = await seed();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const recoveryActionsSvc = issueRecoveryActionService(db);

    // Drive the action to `escalated` the same way a real exhausted-retry
    // budget would (see upsertSourceScoped's recovery-budget-exhaustion
    // branch): maxAttempts: 1 plus a second upsert exhausts it.
    await recoveryActionsSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: null,
      cause: "workspace_validation_failed",
      fingerprint: "workspace-validation:fingerprint",
      nextAction: "Wait for the platform fix.",
      maxAttempts: 1,
    });
    const escalated = await recoveryActionsSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: null,
      cause: "workspace_validation_failed",
      fingerprint: "workspace-validation:fingerprint",
      nextAction: "Wait for the platform fix.",
      maxAttempts: 1,
    });
    expect(escalated.status).toBe("escalated");

    const result = await recovery.sweepRecoveryActionsForResolvedPlatformCauses();

    expect(result).toEqual({ candidates: [], cleared: 0, woken: 0, failed: 0 });
    const [row] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, escalated.id));
    expect(row?.status).toBe("escalated");
  });

  it("does not clear a bounded-retry action that has not exhausted its attempts", async () => {
    const { companyId, sourceIssueId } = await seed();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const recoveryActionsSvc = issueRecoveryActionService(db);

    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: null,
      cause: "workspace_validation_failed",
      fingerprint: "workspace-validation:fingerprint",
      nextAction: "Wait for the platform fix.",
      maxAttempts: 5,
    });
    expect(action.status).toBe("active");

    const result = await recovery.sweepRecoveryActionsForResolvedPlatformCauses();

    expect(result).toEqual({ candidates: [], cleared: 0, woken: 0, failed: 0 });
    const [row] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(row?.status).toBe("active");
  });

  it("is idempotent — a second pass finds nothing left to clear", async () => {
    const { companyId, sourceIssueId } = await seed();
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const recovery = recoveryService(db, { enqueueWakeup });
    const recoveryActionsSvc = issueRecoveryActionService(db);

    await recoveryActionsSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: null,
      cause: "workspace_validation_failed",
      fingerprint: "workspace-validation:fingerprint",
      nextAction: "Wait for the platform fix.",
    });

    const first = await recovery.sweepRecoveryActionsForResolvedPlatformCauses();
    const second = await recovery.sweepRecoveryActionsForResolvedPlatformCauses();

    expect(first.cleared).toBe(1);
    expect(second).toEqual({ candidates: [], cleared: 0, woken: 0, failed: 0 });
  });

  it("does not cross company boundaries — another company's done+labeled issue does not clear it", async () => {
    // Company A's own platform issue for this cause is still open — only
    // company B has a `done` issue labeled for the same cause string. If the
    // sweep matched by cause alone (ignoring companyId) it would wrongly
    // clear company A's action off company B's fix.
    const { sourceIssueId: sourceIssueA, companyId: companyA } = await seed({ platformIssueStatus: "todo" });
    await seed(); // company B: same cause, its platform issue is done.

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const recovery = recoveryService(db, { enqueueWakeup });
    const recoveryActionsSvc = issueRecoveryActionService(db);

    await recoveryActionsSvc.upsertSourceScoped({
      companyId: companyA,
      sourceIssueId: sourceIssueA,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: null,
      cause: "workspace_validation_failed",
      fingerprint: "workspace-validation:fingerprint",
      nextAction: "Wait for the platform fix.",
    });

    const result = await recovery.sweepRecoveryActionsForResolvedPlatformCauses();
    expect(result).toEqual({ candidates: [], cleared: 0, woken: 0, failed: 0 });
  });
});
