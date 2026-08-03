/**
 * React binding for the agent-run Stop affordance (fork f3, increment 4).
 *
 * Two surfaces press Stop — the transcript card and the tracker popover — and
 * neither can be handed props from `ChatView`/`ChatHeader` without widening
 * upstream files this fork is trying to keep at dispatch-line size. So the
 * pending table is a tiny module-level store shared by both, and the thread to
 * address is read from the route the same way `DiffPanel` already does it.
 *
 * One shared timer, never one per card: the store schedules a single prune
 * when a request is made, and cards re-render off `useSyncExternalStore`.
 *
 * @module agentRunStop
 */
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { RuntimeTaskId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { useCallback, useSyncExternalStore } from "react";

import { providerTaskEnvironment } from "../../state/providerTask";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { toastManager } from "../ui/toast";
import {
  AGENT_RUN_STOP_REENABLE_MS,
  agentRunStopFailureMessage,
  EMPTY_AGENT_RUN_STOP_REQUESTS,
  pruneAgentRunStopRequests,
  withAgentRunStopRequested,
  withoutAgentRunStopRequested,
  type AgentRunStopRequests,
} from "./agentRunStop.logic.ts";

let requests: AgentRunStopRequests = EMPTY_AGENT_RUN_STOP_REQUESTS;
const listeners = new Set<() => void>();
let pruneTimer: ReturnType<typeof setTimeout> | undefined;

function publish(next: AgentRunStopRequests): void {
  if (next === requests) {
    return;
  }
  requests = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AgentRunStopRequests {
  return requests;
}

function schedulePrune(): void {
  if (pruneTimer !== undefined) {
    return;
  }
  pruneTimer = setTimeout(() => {
    pruneTimer = undefined;
    publish(pruneAgentRunStopRequests(requests, Date.now()));
    // Re-arm while anything is still pending. A request made *while* an earlier
    // timer was in flight is not covered by that timer's deadline, and the
    // button state is only recomputed on re-render — so without this a wedged
    // run's Stop button could stay disabled on "Stopping…" indefinitely, which
    // is the exact state the 5s re-enable exists to prevent.
    if (Object.keys(requests).length > 0) {
      schedulePrune();
    }
  }, AGENT_RUN_STOP_REENABLE_MS + 50);
}

/** Exported for tests: leaves the store exactly as a fresh module would. */
export function resetAgentRunStopRequests(): void {
  if (pruneTimer !== undefined) {
    clearTimeout(pruneTimer);
    pruneTimer = undefined;
  }
  publish(EMPTY_AGENT_RUN_STOP_REQUESTS);
}

export function markAgentRunStopRequested(taskIds: ReadonlyArray<string>): void {
  const now = Date.now();
  publish(withAgentRunStopRequested(pruneAgentRunStopRequests(requests, now), taskIds, now));
  schedulePrune();
}

/**
 * fork: f3 F-32 — clears the optimistic mark when the stop was refused, so the
 * card stops saying "Stopping…" the moment the failure toast appears.
 */
export function clearAgentRunStopRequested(taskIds: ReadonlyArray<string>): void {
  publish(withoutAgentRunStopRequested(requests, taskIds));
}

export function useAgentRunStopRequests(): AgentRunStopRequests {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface AgentRunStopController {
  /** False on surfaces with no addressable thread — the button stays hidden. */
  readonly enabled: boolean;
  readonly requests: AgentRunStopRequests;
  readonly stopRuns: (taskIds: ReadonlyArray<string>) => void;
}

/**
 * Resolves the thread from the route rather than from props, because the two
 * mount points (`MessagesTimeline`, `ChatHeader`) are upstream files.
 * `DiffPanel` reads its thread the same way.
 */
export function useAgentRunStop(): AgentRunStopController {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const stopTask = useAtomCommand(providerTaskEnvironment.stopTask);
  const stopRequests = useAgentRunStopRequests();

  const stopRuns = useCallback(
    (taskIds: ReadonlyArray<string>) => {
      if (!routeThreadRef || taskIds.length === 0) {
        return;
      }
      markAgentRunStopRequested(taskIds);
      for (const taskId of taskIds) {
        void stopTask({
          environmentId: routeThreadRef.environmentId,
          input: {
            threadId: routeThreadRef.threadId,
            taskId: taskId as RuntimeTaskId,
          },
        }).then((result) => {
          // A refusal is the only case worth interrupting for: the happy path's
          // receipt is the run settling in the transcript.
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            // fork: f3 F-32 — the optimistic "Stopping…" mark must not outlive
            // the refusal it was written for.
            clearAgentRunStopRequested([taskId]);
            toastManager.add({
              type: "error",
              title: "Could not stop the agent run",
              description: agentRunStopFailureMessage(Cause.squash(result.cause)),
            });
          }
        });
      }
    },
    [routeThreadRef, stopTask],
  );

  return {
    enabled: routeThreadRef !== null,
    requests: stopRequests,
    stopRuns,
  };
}
