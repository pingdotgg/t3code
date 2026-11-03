import type { ThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import * as Haptics from "expo-haptics";

import { writeComposerContextClipboard } from "./composerContextClipboard";
import { tryCopyTextWithHaptic } from "./copyTextWithHaptic";

/** Resolves false, after logging why, when the clipboard write fails. */
export async function copyThreadReference(target: ThreadReferenceCopyTarget): Promise<boolean> {
  if (!target.fragment)
    return tryCopyTextWithHaptic(target.value, { target: target.clipboardTarget });
  try {
    await writeComposerContextClipboard(target.value, target.fragment);
  } catch (error) {
    console.error(`Failed to copy ${target.clipboardTarget} to the clipboard.`, error);
    return false;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  return true;
}
