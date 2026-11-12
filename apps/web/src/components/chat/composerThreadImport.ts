import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

export function remainingComposerAttachmentSlots(
  attachmentCount: number,
  pendingThreadImports: number,
) {
  return Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - attachmentCount - pendingThreadImports);
}

export async function importComposerThreadAttachment(input: {
  readonly targetKey: string;
  readonly pendingImports: Map<string, number>;
  readonly countReservedAttachments: () => number;
  readonly load: () => Promise<File>;
  readonly isActive: () => boolean;
  readonly attach: (file: File) => Promise<boolean>;
  readonly onLimitReached: () => void;
}): Promise<void> {
  if (input.countReservedAttachments() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    input.onLimitReached();
    return;
  }
  input.pendingImports.set(input.targetKey, (input.pendingImports.get(input.targetKey) ?? 0) + 1);
  let reserved = true;
  const release = () => {
    if (!reserved) return;
    reserved = false;
    const remaining = (input.pendingImports.get(input.targetKey) ?? 0) - 1;
    if (remaining > 0) input.pendingImports.set(input.targetKey, remaining);
    else input.pendingImports.delete(input.targetKey);
  };
  try {
    const file = await input.load();
    if (!input.isActive()) return;
    release();
    await input.attach(file);
  } finally {
    release();
  }
}
