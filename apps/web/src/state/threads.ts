import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationThread, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);
const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}

function threadStateFromResult(
  result: AsyncResult.AsyncResult<EnvironmentThreadState, unknown>,
): EnvironmentThreadState {
  return Option.getOrElse(AsyncResult.value(result), () => EMPTY_ENVIRONMENT_THREAD_STATE);
}

/** Fetches every older page before resolving with the complete thread detail. */
export function loadCompleteThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  timeoutMs = 30_000,
): Promise<OrchestrationThread> {
  const stateAtom = environmentThreads.stateAtom(environmentId, threadId);
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let requestPending = false;
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

    const finish = (
      result: { ok: true; thread: OrchestrationThread } | { ok: false; error: Error },
    ) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      unsubscribe?.();
      if (result.ok) resolve(result.thread);
      else reject(result.error);
    };

    const advance = (result: AsyncResult.AsyncResult<EnvironmentThreadState, unknown>) => {
      const state = threadStateFromResult(result);
      const error = Option.getOrNull(state.error);
      if (error !== null) {
        finish({ ok: false, error: new Error(error) });
        return;
      }
      const thread = Option.getOrNull(state.data);
      if (thread !== null && !threadHasOlderTurns(state)) {
        finish({ ok: true, thread });
        return;
      }
      if (state.status !== "live") {
        finish({
          ok: false,
          error: new Error(
            requestPending
              ? "The environment disconnected while loading the full thread history."
              : "Reconnect the environment to load the full thread history.",
          ),
        });
        return;
      }
      const page = Option.getOrNull(state.page);
      if (page?.loadingOlder) {
        requestPending = false;
        return;
      }
      if (thread === null || requestPending) return;

      requestPending = true;
      if (!requestOlderThreadTurns(environmentId, threadId)) {
        finish({ ok: false, error: new Error("Could not load the full thread history.") });
      }
    };

    timeoutId = globalThis.setTimeout(
      () => finish({ ok: false, error: new Error("Could not load the full thread history.") }),
      timeoutMs,
    );
    unsubscribe = appAtomRegistry.subscribe(stateAtom, advance);
    advance(appAtomRegistry.get(stateAtom));
  });
}
