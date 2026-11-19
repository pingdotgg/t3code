import { useAtomSet } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createLinkedThreadSession,
  type LinkedThreadOpen,
  type LinkedThreadTarget,
  resolveLinkedThreadOpen,
} from "@t3tools/client-runtime/linked-thread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useState, useSyncExternalStore } from "react";

import { getDocumentActivity } from "../lib/documentActivity";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironment } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useAtomCommand } from "./use-atom-command";

/** The linked environment's thread the read-only view shows, or none. */
export const linkedThreadViewAtom = Atom.make<LinkedThreadTarget | null>(null).pipe(
  Atom.withLabel("linked-thread-view"),
);

/** Opens a linked environment's thread in the read-only view. */
export function useOpenLinkedThread(): (target: LinkedThreadTarget) => void {
  return useAtomSet(linkedThreadViewAtom);
}

/**
 * How a click opens a thread that a thread in `viaEnvironmentId` says is on a linked environment:
 * in place when this client is connected there itself, else read-only through the link. Once the
 * link is gone a saved environment opens in place, where the client can reconnect to it; with
 * neither, the read-only view says what to link again.
 */
export function useLinkedThreadOpener(
  viaEnvironmentId: EnvironmentId,
  thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly label: string;
      }
    | undefined,
  title: string | null,
): { readonly mode: Exclude<LinkedThreadOpen, "unavailable">; readonly open: () => void } | null {
  const navigate = useNavigate();
  const openLinked = useOpenLinkedThread();
  const own = useEnvironment(thread?.environmentId ?? null);
  const connected = own?.connection.phase === "connected";
  const links = useLinkedEnvironments(thread === undefined || connected ? null : viaEnvironmentId);
  if (thread === undefined) return null;
  const resolved = resolveLinkedThreadOpen({
    environmentId: thread.environmentId,
    viaEnvironmentId,
    own: own === null ? undefined : { connected },
    linked: links.has(thread.environmentId),
  });
  const mode = resolved === "direct" ? "direct" : "linked";
  return {
    mode,
    open: () => {
      if (mode === "linked") {
        openLinked({ viaEnvironmentId, ...thread, label: own?.label ?? thread.label, title });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.threadId)),
      });
    },
  };
}

/**
 * The transcript of `target`, read through the environment that links to it. Reads start when the
 * calling view mounts and stop when it unmounts; key the view by its target.
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
      isActive: () => getDocumentActivity().visible,
    }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { state, session };
}
