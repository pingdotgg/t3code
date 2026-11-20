import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  connectLinkedEnvironment,
  type LinkedThreadOpen,
  resolveLinkedThreadOpen,
} from "@t3tools/client-runtime/linked-thread";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";

import type { TurnItemSource } from "../components/chat/timelineRowContext";
import { useRightPanelStore } from "../rightPanelStore";
import { connectPairing, reachesEnvironment } from "../connection/onboarding";
import type { LinkedThreadSurface } from "../linkedThreadSurface";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironment } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

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

/** A linked environment the add-environment dialog opens for, with what is known about it filled in. */
export interface AddEnvironmentPrefill {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly host: string | null;
}

export const addEnvironmentPrefillAtom = Atom.make<AddEnvironmentPrefill | null>(null).pipe(
  Atom.withLabel("add-environment-prefill"),
);

export type LinkedEnvironmentConnectState =
  | { readonly phase: "idle" | "connecting" }
  | { readonly phase: "unreachable"; readonly label: string }
  /** The user pairs with a code of their own; `prefill` reopens the dialog for it. */
  | { readonly phase: "manual"; readonly prefill: AddEnvironmentPrefill };

// Kept like the tab's reads, so the tab still says what happened after a visit to Settings.
const linkedEnvironmentConnectAtom = Atom.family((key: string) =>
  Atom.make<LinkedEnvironmentConnectState>({ phase: "idle" }).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`linked-environment-connect:${key}`),
  ),
);

/**
 * Connects this client to the environment `surface`'s thread lives in. One step when the linking
 * environment can get a pairing for this client: the thread then opens there and the tab closes.
 * Otherwise the add-environment dialog opens for that machine.
 */
export function useConnectLinkedEnvironment(
  panelRef: ScopedThreadRef,
  surface: LinkedThreadSurface,
) {
  const navigate = useNavigate();
  const setPrefill = useAtomSet(addEnvironmentPrefillAtom);
  const mayPair = useAtomValue(
    peerLinkEnvironment.pairClient.permissionAtom(surface.viaEnvironmentId),
  );
  const quiet = { reportFailure: false, reportDefect: false } as const;
  const requestPairing = useAtomCommand(peerLinkEnvironment.pairClient, quiet);
  const reaches = useAtomCommand(reachesEnvironment, quiet);
  const pair = useAtomCommand(connectPairing, quiet);
  const [state, setState] = useAtom(
    linkedEnvironmentConnectAtom(`${scopedThreadKey(panelRef)}:${surface.id}`),
  );
  const addWithCode = (prefill: AddEnvironmentPrefill) => {
    setPrefill(prefill);
    void navigate({ to: "/settings/connections" });
  };
  const connect = async () => {
    setState({ phase: "connecting" });
    const outcome = await connectLinkedEnvironment({
      label: surface.label,
      requestPairing: async () => {
        // Without it the linking environment refuses; the user can still pair by hand.
        if (!mayPair) return null;
        const result = await requestPairing({
          environmentId: surface.viaEnvironmentId,
          input: { environmentId: surface.environmentId },
        });
        return result._tag === "Success" ? result.value : null;
      },
      reaches: async (host) => {
        const result = await reaches({ host, environmentId: surface.environmentId });
        return result._tag === "Success" && result.value;
      },
      pair: async ({ host, pairingCode }) => {
        const result = await pair({
          host,
          pairingCode,
          expectedEnvironmentId: surface.environmentId,
        });
        return result._tag === "Success";
      },
    });
    if (outcome.type === "unreachable") {
      setState({ phase: "unreachable", label: outcome.label });
      return outcome;
    }
    if (outcome.type === "connected") {
      setState({ phase: "idle" });
      // The thread opens where every thread on a connected environment does, so its tab is done.
      useRightPanelStore.getState().closeSurface(panelRef, surface.id);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(surface.environmentId, surface.threadId)),
      });
      return outcome;
    }
    const prefill = {
      environmentId: surface.environmentId,
      label: outcome.label,
      host: outcome.host,
    };
    setState({ phase: "manual", prefill });
    addWithCode(prefill);
    return outcome;
  };
  return { state, connect, addWithCode };
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
