import type { ThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { tryCopyTextWithHaptic } from "./copyTextWithHaptic";

export async function copyThreadReference(target: ThreadReferenceCopyTarget): Promise<boolean> {
  return tryCopyTextWithHaptic(target.value, { target: target.clipboardTarget });
}
