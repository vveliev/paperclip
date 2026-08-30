-- BLA-687: backfill the current blocked/null-descriptor population before the
-- CHECK constraint below goes live, so this migration doesn't fail against a
-- database that already has rows violating the invariant it's about to add.
-- The synthesized descriptor names board as owner (matching how the recovery
-- escalation writers now populate this field going forward) and preserves
-- whatever recovery evidence is available as the action text.
UPDATE "issues"
SET "unblock_descriptor" = jsonb_build_object(
  'owner', 'board',
  'action', 'Legacy escalation predating the BLA-687 invariant. Inspect the issue''s recovery evidence/comments and choose a disposition.'
)
WHERE "status" = 'blocked' AND "unblock_descriptor" IS NULL;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_blocked_requires_unblock_descriptor_check" CHECK ("issues"."status" <> 'blocked' or "issues"."unblock_descriptor" is not null);
