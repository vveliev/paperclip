import postgres from "postgres";

/**
 * Database invariants this fork maintains outside the numbered migration chain.
 *
 * Why these are not migrations: upstream adds roughly thirty migrations a month,
 * so any migration this fork carries collides on its number at almost every sync.
 * These statements have been renumbered three times for that reason alone
 * (0228 -> 0234 -> 0238), and upstream has since taken 0238 as well.
 *
 * Keeping them here removes that recurring conflict permanently. It is safe
 * because nothing here is part of the drizzle schema: a trigger and its function
 * are invisible to drizzle snapshots, so the migration chain never described this
 * state anyway. The net schema delta of the two migrations this replaces was
 * empty — one added a CHECK constraint and the next dropped it again.
 *
 * Every statement is idempotent, and the whole step is skipped once the trigger
 * exists, so a normal boot costs one catalog query.
 */

const AUTOFILL_TRIGGER_NAME = "issues_blocked_descriptor_autofill";

const AUTOFILL_ACTION =
  "Auto-filled: a write set this issue to blocked without recording an unblock premise. " +
  "This is almost always the recovery sweep parking a stranded run " +
  "(see server/src/services/recovery/service.ts). No owner or action was captured, so " +
  "nothing can re-check this automatically. Inspect the issue's run evidence and comments, " +
  "then either replace this descriptor with the real premise and owner, or move the issue " +
  "out of blocked.";

// The backfill says something different from the trigger on purpose. A row the
// trigger filled was written while the guard was in place; a row the backfill
// filled predates it and nobody knows how long it sat there. Keeping the two
// distinguishable is worth a second string -- the migration this replaces drew
// the same distinction.
const BACKFILL_ACTION =
  "Auto-filled by a backfill: this issue was already blocked with no unblock premise " +
  "recorded before the descriptor guard was installed, so how it got here is not known. " +
  "Inspect the issue's run evidence and comments and re-scope it, or move it out of blocked.";

// The function body embeds these as SQL string literals. Escaping the quotes keeps
// that a literal and nothing else: no dollar-quote tag to collide with, so editing
// the copy above can never change the shape of the statement.
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type DatabaseInvariantResult = {
  /** False when the trigger was already present, which is the steady state. */
  applied: boolean;
  /** Rows the backfill filled in. Only non-zero on the pass that installs the trigger. */
  backfilled: number;
};

/**
 * Guarantees that a blocked issue always records an owner and an action.
 *
 * A blocked issue with no `unblock_descriptor` names nobody and no next step, so
 * nothing can re-check it and no audit can surface it. The application enforces
 * this in issues.ts update(); this trigger is the last-resort guard behind that,
 * covering any write path the service layer does not own — raw SQL, or upstream
 * code this fork does not control.
 *
 * It fills the descriptor in rather than rejecting the write, deliberately. An
 * earlier version used a CHECK constraint. Rejecting turned a metadata gap into an
 * outage: a recovery write parked a stranded issue as blocked without a
 * descriptor, the CHECK rejected it, and because the recovery stages were chained
 * with a single terminal catch, every later stage was skipped for that whole tick.
 * A synthesized descriptor is visible, auditable, and honest that it was
 * auto-filled; a rejected transaction was silent.
 */
export async function applyDatabaseInvariants(url: string): Promise<DatabaseInvariantResult> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const existing = await sql`
      SELECT 1 FROM pg_trigger
      WHERE tgname::text = ${AUTOFILL_TRIGGER_NAME} AND NOT tgisinternal
      LIMIT 1
    `;
    if (existing.length > 0) return { applied: false, backfilled: 0 };

    let backfilled = 0;
    await sql.begin(async (tx) => {
      await tx.unsafe(`
        CREATE OR REPLACE FUNCTION "${AUTOFILL_TRIGGER_NAME}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."status" = 'blocked' AND NEW."unblock_descriptor" IS NULL THEN
            NEW."unblock_descriptor" := jsonb_build_object('owner', 'board', 'action', ${sqlLiteral(AUTOFILL_ACTION)});
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await tx.unsafe(`DROP TRIGGER IF EXISTS "${AUTOFILL_TRIGGER_NAME}" ON "issues";`);
      await tx.unsafe(`
        CREATE TRIGGER "${AUTOFILL_TRIGGER_NAME}"
          BEFORE INSERT OR UPDATE ON "issues"
          FOR EACH ROW
          EXECUTE FUNCTION "${AUTOFILL_TRIGGER_NAME}"();
      `);
      // Backfill rows that predate the trigger. The trigger covers every write
      // from here on, so this only ever does work on the pass that installs it.
      const filled = await tx`
        UPDATE "issues"
        SET "unblock_descriptor" = jsonb_build_object('owner', 'board', 'action', ${BACKFILL_ACTION}::text)
        WHERE "status" = 'blocked' AND "unblock_descriptor" IS NULL
      `;
      backfilled = filled.count ?? 0;

      // An earlier version of this invariant shipped as a CHECK constraint that
      // rejected the write. Remove it if a database still carries it.
      await tx.unsafe(
        `ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_blocked_requires_unblock_descriptor_check";`,
      );
    });
    return { applied: true, backfilled };
  } finally {
    await sql.end();
  }
}
