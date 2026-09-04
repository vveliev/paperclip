import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDatabaseInvariants } from "./invariants.js";
import { applyPendingMigrations, createDb } from "./client.js";
import { companies, issues } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// These invariants used to ship as numbered migrations, which collided with an
// upstream migration number at nearly every sync. They now install from
// packages/db/src/invariants.ts, so this suite is what pins the behaviour --
// there is no migration file left to read it from.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("applyDatabaseInvariants", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-database-invariants-");
  }, 240_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(db: ReturnType<typeof createDb>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Invariants",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function triggerExists(db: ReturnType<typeof createDb>) {
    const rows = await db.execute(
      sql`SELECT 1 FROM pg_trigger WHERE tgname::text = 'issues_blocked_descriptor_autofill' AND NOT tgisinternal`,
    );
    return rows.length > 0;
  }

  it("is already installed by the migration path, and re-running is a no-op", async () => {
    const db = createDb(tempDb.connectionString);
    // The harness runs applyPendingMigrations, which wraps applyDatabaseInvariants.
    // Finding the trigger here is what proves that wiring, not just the SQL.
    expect(await triggerExists(db)).toBe(true);

    const repeat = await applyDatabaseInvariants(tempDb.connectionString);
    expect(repeat.applied).toBe(false);
    expect(repeat.backfilled).toBe(0);
  });

  it("is reapplied by applyPendingMigrations even when no migrations are pending", async () => {
    // The invariants call sits outside applyPendingMigrationsInner precisely so the
    // up-to-date early return still reaches it. Without this test, moving the call
    // inside that function -- before its `if (upToDate) return` -- would go unnoticed.
    const db = createDb(tempDb.connectionString);
    await db.execute(sql`DROP TRIGGER IF EXISTS "issues_blocked_descriptor_autofill" ON "issues"`);
    expect(await triggerExists(db)).toBe(false);

    // The database is fully migrated at this point, so this is the early-return path.
    await applyPendingMigrations(tempDb.connectionString);

    expect(await triggerExists(db)).toBe(true);
  });

  it("drops the CHECK constraint an older version of this invariant installed", async () => {
    // A fork database that ran the retired migrations still carries the CHECK. It
    // rejected the write instead of filling it in, which is what turned a metadata
    // gap into an outage, so converging away from it is the point.
    const db = createDb(tempDb.connectionString);
    await db.execute(sql`DROP TRIGGER IF EXISTS "issues_blocked_descriptor_autofill" ON "issues"`);
    await db.execute(
      sql`ALTER TABLE "issues" ADD CONSTRAINT "issues_blocked_requires_unblock_descriptor_check" CHECK ("issues"."status" <> 'blocked' or "issues"."unblock_descriptor" is not null)`,
    );
    const present = async () =>
      (await db.execute(
        sql`SELECT 1 FROM pg_constraint WHERE conname::text = 'issues_blocked_requires_unblock_descriptor_check'`,
      )).length > 0;
    expect(await present()).toBe(true);

    await applyDatabaseInvariants(tempDb.connectionString);

    expect(await present()).toBe(false);
    expect(await triggerExists(db)).toBe(true);
  });

  it("reinstalls the trigger if it goes missing, and backfills what slipped through", async () => {
    const db = createDb(tempDb.connectionString);
    const companyId = await seedCompany(db);

    // Drop the trigger, then write a blocked issue with no descriptor -- the exact
    // state the invariant exists to repair.
    await db.execute(sql`DROP TRIGGER IF EXISTS "issues_blocked_descriptor_autofill" ON "issues"`);
    expect(await triggerExists(db)).toBe(false);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Slipped through while the trigger was absent",
      status: "blocked",
      priority: "medium",
      issueNumber: 9,
      identifier: "INV-9",
    });
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(before?.unblockDescriptor).toBeNull();

    const result = await applyDatabaseInvariants(tempDb.connectionString);
    expect(result.applied).toBe(true);
    expect(result.backfilled).toBeGreaterThanOrEqual(1);
    expect(await triggerExists(db)).toBe(true);

    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect((after?.unblockDescriptor as { owner?: unknown })?.owner).toBe("board");
    // The backfill is worded differently from the trigger on purpose: this row was
    // already blocked before the guard existed, and that is worth telling apart.
    expect(String((after?.unblockDescriptor as { action?: unknown })?.action)).toContain(
      "Auto-filled by a backfill",
    );
  });

  it("fills the descriptor for a blocked write that supplies none", async () => {
    await applyDatabaseInvariants(tempDb.connectionString);
    const db = createDb(tempDb.connectionString);
    const companyId = await seedCompany(db);
    const issueId = randomUUID();

    // A raw insert, bypassing the service layer entirely -- this is the path the
    // trigger exists to cover.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no premise",
      status: "blocked",
      priority: "medium",
      issueNumber: 1,
      identifier: "INV-1",
    });

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row?.unblockDescriptor).toBeTruthy();
    expect((row?.unblockDescriptor as { owner?: unknown })?.owner).toBe("board");
    expect(String((row?.unblockDescriptor as { action?: unknown })?.action)).toContain("Auto-filled");
  });

  it("leaves a descriptor the caller supplied untouched", async () => {
    await applyDatabaseInvariants(tempDb.connectionString);
    const db = createDb(tempDb.connectionString);
    const companyId = await seedCompany(db);
    const issueId = randomUUID();
    const supplied = { owner: "board" as const, action: "Waiting on the vendor to reply." };

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with a real premise",
      status: "blocked",
      unblockDescriptor: supplied,
      priority: "medium",
      issueNumber: 2,
      identifier: "INV-2",
    });

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row?.unblockDescriptor).toEqual(supplied);
  });

  it("does not touch an issue that is not blocked", async () => {
    await applyDatabaseInvariants(tempDb.connectionString);
    const db = createDb(tempDb.connectionString);
    const companyId = await seedCompany(db);
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Open work",
      status: "todo",
      priority: "medium",
      issueNumber: 3,
      identifier: "INV-3",
    });

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row?.unblockDescriptor).toBeNull();
  });

  it("fills the descriptor when an existing issue transitions into blocked", async () => {
    await applyDatabaseInvariants(tempDb.connectionString);
    const db = createDb(tempDb.connectionString);
    const companyId = await seedCompany(db);
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Becomes blocked later",
      status: "todo",
      priority: "medium",
      issueNumber: 4,
      identifier: "INV-4",
    });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect((row?.unblockDescriptor as { owner?: unknown })?.owner).toBe("board");
  });
});
