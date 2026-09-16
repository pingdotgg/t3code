import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";

import { useLazyPullRequestLinking } from "~/hooks/usePullRequestLinking";
import { readThreadShell } from "~/state/entities";

import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";

/**
 * The right-click behind every pull request number a thread wears: the sidebar row, the composer's
 * branch toolbar, the legacy sidebar.
 *
 * Those numbers are the only place a link is visible from the thread you are reading, so they are
 * where a reader goes to undo one. Unlinking was reachable before this only from the right panel or
 * from the original URL in the transcript, which may be hundreds of turns up or may never have been
 * a message at all when the agent linked the pull request itself.
 *
 * Whether the thread is linked is read when the menu opens, and again when the item is chosen: a
 * menu sits open for as long as it takes to read, and the agent can link or unlink from underneath
 * it in that time. That same lateness is why the linking state is resolved per click here rather
 * than subscribed to: this hook is mounted once per row of the thread list.
 */
export function useThreadPullRequestLinkContextMenu(threadRef: ScopedThreadRef | null | undefined) {
  const resolvePullRequestLinking = useLazyPullRequestLinking(threadRef?.environmentId);
  return useCallback(
    (
      event: ReactMouseEvent,
      pullRequest: {
        readonly url: string | undefined;
        readonly providerKind: string | undefined;
      },
    ) => {
      const url = pullRequest.url;
      if (url === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      const linking = resolvePullRequestLinking();
      const linked = threadRef != null && linking.isLinked(readThreadShell(threadRef), url);
      void showPullRequestLinkContextMenu({
        url,
        openLabel: openOnHostLabel(pullRequest.providerKind ?? ""),
        position: { x: event.clientX, y: event.clientY },
        // Offered only for a number the thread is actually linked to. The same badge also shows a
        // pull request read off the thread's branch, and that one is a fact about git rather than
        // a choice anyone made to undo.
        ...(linked && threadRef != null
          ? {
              unlinkFromThread: async (target: string) => {
                const current = resolvePullRequestLinking();
                if (!current.isLinked(readThreadShell(threadRef), target)) return;
                await current.changeLink(threadRef, target, false);
              },
            }
          : {}),
      });
    },
    [resolvePullRequestLinking, threadRef],
  );
}
