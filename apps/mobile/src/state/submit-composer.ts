import type { MessageId } from "@t3tools/contracts";

import type { ComposerEditorHandle } from "../native/T3ComposerEditor.types";
import { getQueuedRunEdit } from "./queued-run-edit";

/** Keep a pending native correction bound to the edit that initiated submission. */
export async function submitComposer(
  threadKey: string,
  editor: ComposerEditorHandle | null,
  send: () => Promise<MessageId | null>,
  isActive: () => boolean,
): Promise<MessageId | null> {
  const edit = getQueuedRunEdit(threadKey);
  const isCurrent = () => isActive() && getQueuedRunEdit(threadKey) === edit;
  if ((await editor?.prepareForSubmit?.(isCurrent)) === false || !isCurrent()) return null;
  return send();
}
