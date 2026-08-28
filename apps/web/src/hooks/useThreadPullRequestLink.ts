import type { ScopedThreadRef, ThreadLinkedPullRequest } from "@t3tools/contracts";
import { useCallback } from "react";

import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Link and unlink, both through `thread.meta.update`. These are the only
 * callers allowed to send `linkedPullRequest`: the command is multi-field, so
 * any other caller spreading thread state would silently unlink.
 */
export function useThreadPullRequestLinkActions() {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const linkPullRequest = useCallback(
    (threadRef: ScopedThreadRef, link: ThreadLinkedPullRequest) =>
      updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, linkedPullRequest: link },
      }),
    [updateThreadMetadata],
  );
  const unlinkPullRequest = useCallback(
    (threadRef: ScopedThreadRef) =>
      updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, linkedPullRequest: null },
      }),
    [updateThreadMetadata],
  );
  return { linkPullRequest, unlinkPullRequest };
}
