import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type LinkedThreadOpen,
  resolveLinkedThreadOpen,
} from "@t3tools/client-runtime/linked-thread";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";

import type { TurnItemSource } from "../components/chat/timelineRowContext";
import { useRightPanelStore } from "../rightPanelStore";
import type { LinkedThreadSurface } from "../linkedThreadSurface";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironment } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useEnvironmentQuery } from "./query";

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

type TabKey = readonly [
  panelEnvironmentId: EnvironmentId,
  panelThreadId: ThreadId,
  surfaceId: string,
  viaEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
];

const targetOf = (
  surface: Pick<LinkedThreadSurface, "viaEnvironmentId" | "environmentId" | "threadId">,
) => ({
  environmentId: surface.viaEnvironmentId,
  input: { environmentId: surface.environmentId, threadId: surface.threadId },
});

/** One tab's subscription, which also keeps the tab's title to the thread's own. */
const tabViewAtom = Atom.family((key: string) => {
  const [panelEnvironmentId, panelThreadId, surfaceId, viaEnvironmentId, environmentId, threadId] =
    JSON.parse(key) as TabKey;
  const panelRef = scopeThreadRef(panelEnvironmentId, panelThreadId);
  const view = peerLinkEnvironment.threadView(
    targetOf({ viaEnvironmentId, environmentId, threadId }),
  );
  return Atom.make((get) => {
    const live = get(view);
    const title = AsyncResult.getOrElse(live, () => null)?.thread.projection?.thread.title;
    if (title) useRightPanelStore.getState().setLinkedThreadTitle(panelRef, surfaceId, title);
    return live;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`linked-thread-tab-view:${key}`));
});

/**
 * The thread of `surface`, streamed through the environment that links to it for the tab in
 * `panelRef`'s panel. The stream runs only while `visible`; what it last showed stays.
 */
export function useLinkedThreadView(
  panelRef: ScopedThreadRef,
  surface: Pick<LinkedThreadSurface, "id" | "viaEnvironmentId" | "environmentId" | "threadId">,
  visible: boolean,
) {
  const key: TabKey = [
    panelRef.environmentId,
    panelRef.threadId,
    surface.id,
    surface.viaEnvironmentId,
    surface.environmentId,
    surface.threadId,
  ];
  const live = useEnvironmentQuery(visible ? tabViewAtom(JSON.stringify(key)) : null);
  const view = useAtomValue(peerLinkEnvironment.lastThreadView(targetOf(surface)));
  return {
    view,
    /** Why the stream is not running: it ended, or it waits to ask again. */
    error: live.failure ?? view?.error ?? null,
    /** Asks again now. */
    retry: live.refresh,
  };
}

/** Where a linked thread's expanded rows read an item in full: through the linking environment. */
export const linkedThreadItemSource = (
  target: Pick<LinkedThreadSurface, "viaEnvironmentId" | "environmentId">,
): TurnItemSource => ({
  detail: (input) =>
    peerLinkEnvironment.threadItem({
      environmentId: target.viaEnvironmentId,
      input: { environmentId: target.environmentId, ...input },
    }),
});
