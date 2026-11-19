import {
  createLinkedThreadSession,
  type LinkedThreadTarget,
} from "@t3tools/client-runtime/linked-thread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { useEnvironments } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useAtomCommand } from "./use-atom-command";

/**
 * What places a delegated task's thread: this app's own connections, and the links `environmentId`
 * holds. Links are listed only while a task runs somewhere this app is not connected to.
 */
export function useLinkedThreadReach(
  environmentId: EnvironmentId,
  subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "childThreadId" | "remoteChild">>,
) {
  const { presentationById } = useEnvironments();
  const ownConnection = (id: EnvironmentId) => {
    const own = presentationById.get(id);
    return own && { connected: own.connection.phase === "connected" };
  };
  const links = useLinkedEnvironments(
    subagents.some(
      (subagent) =>
        subagent.childThreadId === null &&
        subagent.remoteChild !== undefined &&
        ownConnection(subagent.remoteChild.environmentId)?.connected !== true,
    )
      ? environmentId
      : null,
  );
  return { ownConnection, isLinked: (id: EnvironmentId) => links.has(id) };
}

/**
 * The transcript of `target`, read through the environment that links to it. Reads start when the
 * calling screen mounts, stop when it unmounts, and wait while the app is in the background or
 * `isFocused` says another screen covers this one.
 */
export function useLinkedThreadSession(target: LinkedThreadTarget, isFocused: () => boolean) {
  const read = useAtomCommand(peerLinkEnvironment.readThread, {
    reportFailure: false,
    reportDefect: false,
  });
  const [session] = useState(() =>
    createLinkedThreadSession({
      read: async (cursor) => {
        const result = await read({
          environmentId: target.viaEnvironmentId,
          input: { environmentId: target.environmentId, threadId: target.threadId, ...cursor },
        });
        return result._tag === "Success"
          ? { ok: true, page: result.value }
          : { ok: false, error: squashAtomCommandFailure(result) };
      },
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      isActive: () => AppState.currentState === "active" && isFocused(),
    }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { state, session };
}
