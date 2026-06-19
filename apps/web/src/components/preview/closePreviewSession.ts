import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PreviewCloseInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { beginPreviewSessionClose, cancelPreviewSessionClose } from "~/previewStateStore";

interface ClosePreviewSessionInput<E> {
  readonly closePreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewCloseInput;
  }) => Promise<AtomCommandResult<void, E>>;
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly tabId: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Optimistically closes a preview while suppressing stale list responses for
 * the same tab. A failed close restores the last known snapshot.
 */
export async function closePreviewSession<E>(
  input: ClosePreviewSessionInput<E>,
): Promise<AtomCommandResult<void, E>> {
  beginPreviewSessionClose(input.threadRef, input.tabId);
  const result = await input.closePreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, tabId: input.tabId },
  });
  if (result._tag === "Failure") {
    cancelPreviewSessionClose(input.threadRef, input.snapshot, input.tabId);
  }
  return result;
}
