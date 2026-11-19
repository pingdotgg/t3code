import {
  createLinkedThreadSession,
  type LinkedThreadTarget,
} from "@t3tools/client-runtime/linked-thread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { peerLinkEnvironment } from "./peerLinks";
import { useAtomCommand } from "./use-atom-command";

/**
 * The transcript of `target`, read through the environment that links to it. Reads start when the
 * calling screen mounts, stop when it unmounts, and wait while the app is in the background.
 */
export function useLinkedThreadSession(target: LinkedThreadTarget) {
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
      isActive: () => AppState.currentState === "active",
    }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { state, session };
}
