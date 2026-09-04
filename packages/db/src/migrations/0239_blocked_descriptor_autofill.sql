-- Replace BLA-687's CHECK constraint with a BEFORE-write trigger that fills the
-- descriptor in rather than rejecting the write.
--
-- Numbered 0239 because this fork was rebased onto upstream/master, which had
-- already claimed the numbers this migration and its predecessor were first
-- authored under. Every statement here is idempotent, so re-running it against
-- a fork database that already applied it under an old number is a no-op.
--
-- Why: 0238 added issues_blocked_requires_unblock_descriptor_check to guarantee
-- that a blocked issue always records an owner and action. The guarantee is
-- right. Enforcing it by *rejecting* the write was not, because at least one
-- status='blocked' write path in server/src/services/recovery/service.ts
-- (ensureIssueBlockedByEscalation) does not supply a descriptor, and that is
-- an upstream (paperclipai/paperclip) code path this fork re-inherits on every
-- PAPERCLIP_REF bump -- patching call sites one at a time is permanent
-- divergence a future merge can silently undo, or reintroduce for a path
-- added later. A CHECK constraint rejects the write no matter which caller,
-- upstream or raw SQL, forgets the column; a trigger fills it in instead.
--
-- What it cost, on the live instance 2026-09-03: the recovery sweep tried to park
-- one stranded issue (BLA-819) as blocked, the CHECK rejected it, and because
-- server/src/index.ts chains the five recovery stages with a single terminal
-- .catch(), the whole pass aborted -- every stage after the failing one skipped.
-- 63 identical failures over six hours, roughly one every five minutes, and no
-- stranded-run recovery, stale-lock sweeping, or productivity reconciliation ran
-- in that window. Nothing alerted; the board simply looked idle. One unwritable
-- row silently halted agent recovery board-wide.
--
-- The fix keeps the invariant and drops the failure mode: after this migration a
-- blocked row still cannot exist without a descriptor, but no write can fail
-- because of it. A synthesized descriptor is strictly better than a rejected
-- transaction -- it is visible, auditable, and honest that it was auto-filled,
-- where the rejection produced silence.
--
-- The application-level invariant in issues.ts update() is unaffected and remains
-- the primary path; callers that supply a real descriptor keep theirs untouched.
-- This trigger only ever fires when the descriptor would otherwise be NULL.

DROP TRIGGER IF EXISTS "issues_blocked_descriptor_autofill" ON "issues";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "issues_blocked_descriptor_autofill"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'blocked' AND NEW."unblock_descriptor" IS NULL THEN
    NEW."unblock_descriptor" := jsonb_build_object(
      'owner', 'board',
      'action', 'Auto-filled: a write set this issue to blocked without recording an unblock premise. '
             || 'This is almost always the recovery sweep parking a stranded run '
             || '(see server/src/services/recovery/service.ts). No owner or action was captured, so '
             || 'nothing can re-check this automatically. Inspect the issue''s run evidence and comments, '
             || 'then either replace this descriptor with the real premise and owner, or move the issue '
             || 'out of blocked.'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "issues_blocked_descriptor_autofill"
  BEFORE INSERT OR UPDATE ON "issues"
  FOR EACH ROW
  EXECUTE FUNCTION "issues_blocked_descriptor_autofill"();--> statement-breakpoint

-- Backfill anything the CHECK let through before the trigger existed. Should be a
-- no-op given 0238 backfilled and the CHECK held the line since, but assuming an
-- invariant holds instead of verifying it is exactly how this outage happened.
UPDATE "issues"
SET "unblock_descriptor" = jsonb_build_object(
  'owner', 'board',
  'action', 'Auto-filled during the 0239 backfill: blocked with no unblock premise recorded. Inspect and re-scope.'
)
WHERE "status" = 'blocked' AND "unblock_descriptor" IS NULL;--> statement-breakpoint

-- Dropped last, so the invariant is never unenforced: the trigger is already in
-- place and the backfill already ran by the time the CHECK goes away.
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_blocked_requires_unblock_descriptor_check";
