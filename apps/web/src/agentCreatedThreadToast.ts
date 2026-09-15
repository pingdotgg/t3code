import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadsCreateResult } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "./components/ui/toast";

export type AgentCreatedThread = ThreadsCreateResult;

export type ThreadRouteNavigator = (threadRef: ScopedThreadRef) => void;

// Module-level so a replayed event batch or a re-derived work log cannot
// double-toast the same thread.
const recentAgentThreadIds = new Set<string>();

export function notifyAgentCreatedThreads(input: {
  environmentId: EnvironmentId;
  threads: ReadonlyArray<AgentCreatedThread>;
  navigate: ThreadRouteNavigator;
}): void {
  for (const thread of input.threads) {
    if (recentAgentThreadIds.has(thread.threadId)) {
      continue;
    }
    recentAgentThreadIds.add(thread.threadId);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "New thread created",
        description: thread.title,
        actionProps: {
          children: "Open",
          onClick: () => {
            input.navigate(scopeThreadRef(input.environmentId, thread.threadId));
          },
        },
      }),
    );
  }
}

export function resetAgentCreatedThreadToastsForTests(): void {
  recentAgentThreadIds.clear();
}
