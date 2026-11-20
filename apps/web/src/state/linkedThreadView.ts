import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createLinkedThreadSession,
  type LinkedThreadOpen,
  resolveLinkedThreadOpen,
} from "@t3tools/client-runtime/linked-thread";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { getDocumentActivity } from "../lib/documentActivity";
import type { LinkedThreadSurface } from "../linkedThreadSurface";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironment } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";

/**
 * How a click opens a thread that the thread `panelRef` says is on a linked environment: in place
 * when this client is connected there itself, else as a read-only tab in that thread's right
 * panel, read through its environment. Once the link is gone a saved environment opens in place,
 * where the client can reconnect to it; with neither, the tab says what to link again.
 */
export function useLinkedThreadOpener(
  panelRef: ScopedThreadRef,
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
  const viaEnvironmentId = panelRef.environmentId;
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
        useRightPanelStore.getState().openLinkedThread(panelRef, {
          viaEnvironmentId,
          environmentId: thread.environmentId,
          threadId: thread.threadId,
          label: own?.label ?? thread.label,
          title,
        });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.threadId)),
      });
    },
  };
}

type SessionKey = readonly [
  panelEnvironmentId: EnvironmentId,
  panelThreadId: ThreadId,
  surfaceId: string,
  viaEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
];

/**
 * One tab's reads. It outlives the pane for a while, so coming back to the tab shows what was
 * read and carries on from there; a session nothing subscribes to asks for nothing.
 */
const linkedThreadSessionAtom = Atom.family((key: string) => {
  const [panelEnvironmentId, panelThreadId, surfaceId, viaEnvironmentId, environmentId, threadId] =
    JSON.parse(key) as SessionKey;
  const panelRef = scopeThreadRef(panelEnvironmentId, panelThreadId);
  return Atom.make((get) =>
    createLinkedThreadSession({
      read: async (cursor) => {
        const result = await runAtomCommand(
          get.registry,
          peerLinkEnvironment.readThread,
          { environmentId: viaEnvironmentId, input: { environmentId, threadId, ...cursor } },
          { reportFailure: false, reportDefect: false },
        );
        if (result._tag !== "Success") {
          return { ok: false, error: squashAtomCommandFailure(result) };
        }
        const { title } = result.value.thread;
        if (title) useRightPanelStore.getState().setLinkedThreadTitle(panelRef, surfaceId, title);
        return { ok: true, page: result.value };
      },
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      isActive: () => getDocumentActivity().visible,
    }),
  ).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`linked-thread-session:${key}`));
});

const noSubscription = () => () => {};

/**
 * The transcript of `surface`, read through the environment that links to it for the tab in
 * `panelRef`'s panel. Reads run only while `visible`.
 */
export function useLinkedThreadSession(
  panelRef: ScopedThreadRef,
  surface: Pick<LinkedThreadSurface, "id" | "viaEnvironmentId" | "environmentId" | "threadId">,
  visible: boolean,
) {
  const key: SessionKey = [
    panelRef.environmentId,
    panelRef.threadId,
    surface.id,
    surface.viaEnvironmentId,
    surface.environmentId,
    surface.threadId,
  ];
  const session = useAtomValue(linkedThreadSessionAtom(JSON.stringify(key)));
  const state = useSyncExternalStore(
    visible ? session.subscribe : noSubscription,
    session.getSnapshot,
    session.getSnapshot,
  );
  return { state, session };
}
