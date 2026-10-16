import { waitForTitleRegenerationFailure } from "@t3tools/client-runtime/state/title-regeneration";
import type { CommandId, ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";

const TITLE_REGENERATION_TIMEOUT_MS = 5 * 60_000;

/**
 * Title regeneration runs in the background after its command is accepted.
 * Call `watch` before sending each regeneration command, and call the function
 * it returns if the command is rejected. Failures share one toast that counts
 * them, so a bulk regeneration against a broken provider shows one toast.
 */
export function createTitleRegenerationReporter() {
  let toastId: string | null = null;
  let failures = 0;

  const show = (reason: string) => {
    failures += 1;
    const options = {
      ...stackedThreadToast({
        type: "error",
        title:
          failures === 1
            ? "Failed to regenerate thread title"
            : `Failed to regenerate ${failures} thread titles`,
        description: reason,
      }),
      onClose: () => {
        toastId = null;
        failures = 0;
      },
    };
    if (toastId === null) toastId = toastManager.add(options);
    else toastManager.update(toastId, options);
  };

  return {
    watch(threadRef: ScopedThreadRef, requestId: CommandId): () => void {
      const controller = new AbortController();
      void waitForTitleRegenerationFailure({
        registry: appAtomRegistry,
        atom: environmentThreadShells.threadShellAtom(threadRef),
        requestId,
        timeoutMs: TITLE_REGENERATION_TIMEOUT_MS,
        signal: controller.signal,
      }).then((reason) => {
        if (reason !== null) show(reason);
      });
      return () => controller.abort();
    },
  };
}
