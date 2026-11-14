// Fork: the issues_blocked_descriptor_autofill trigger (packages/db/src/invariants.ts)
// and issues.ts update() give every blocked row a board-owned descriptor. One whose
// action starts with this prefix records that nobody supplied a premise, so upstream
// code that reads a null descriptor as "no one else's move" must read it the same way.
export const AUTO_FILLED_DESCRIPTOR_PREFIX = "Auto-filled";

type UnblockDescriptorLike = { owner?: unknown; action?: string | null } | null | undefined;

export function isAutoFilledUnblockDescriptor(descriptor: UnblockDescriptorLike): boolean {
  return Boolean(descriptor?.action?.startsWith(AUTO_FILLED_DESCRIPTOR_PREFIX));
}

/** The descriptor as upstream expects it: null when nobody supplied a premise. */
export function declaredUnblockDescriptor<T extends UnblockDescriptorLike>(descriptor: T): T | null {
  return !descriptor || isAutoFilledUnblockDescriptor(descriptor) ? null : descriptor;
}
