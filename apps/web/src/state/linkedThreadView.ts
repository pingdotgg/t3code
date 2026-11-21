import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import {
  connectLinkedEnvironment,
  type LinkedThreadOpen,
  ownEnvironmentConnection,
  resolveLinkedThreadOpen,
} from "@t3tools/client-runtime/linked-thread";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";

import type { TurnItemSource } from "../components/chat/timelineRowContext";
import { useRightPanelStore } from "../rightPanelStore";
import { connectPairing, reachesEnvironment } from "../connection/onboarding";
import { openLinkedThreadRead } from "../lib/sideChatPane";
import type { LinkedThreadSurface } from "../linkedThreadSurface";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironment } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

/**
 * How a click opens a thread `panelRef` says is on a linked environment: in place when this client
 * is connected there, else read-only through `panelRef`'s environment, in its right panel or on
 * the main screen as the click asks. A saved environment whose link is gone opens in place.
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
): {
  readonly mode: Exclude<LinkedThreadOpen, "unavailable">;
  readonly open: (intent: SideThreadOpenIntent) => void;
} | null {
  const navigate = useNavigate();
  const viaEnvironmentId = panelRef.environmentId;
  const own = useEnvironment(thread?.environmentId ?? null);
  const ownConnection = ownEnvironmentConnection(own);
  const connected = ownConnection?.connected === true;
  const links = useLinkedEnvironments(thread === undefined || connected ? null : viaEnvironmentId);
  if (thread === undefined) return null;
  const resolved = resolveLinkedThreadOpen({
    environmentId: thread.environmentId,
    viaEnvironmentId,
    own: ownConnection,
    linked: links.has(thread.environmentId),
  });
  const mode = resolved === "direct" ? "direct" : "linked";
  return {
    mode,
    open: (intent) => {
      if (mode === "linked") {
        openLinkedThreadRead({
          panelRef,
          target: {
            viaEnvironmentId,
            environmentId: thread.environmentId,
            threadId: thread.threadId,
            label: own?.label ?? thread.label,
            title,
          },
          intent,
          navigate,
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
  /** Null on the main screen, where no tab shows the title. */
  panelEnvironmentId: EnvironmentId | null,
  panelThreadId: ThreadId | null,
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
  const panelRef =
    panelEnvironmentId === null || panelThreadId === null
      ? null
      : scopeThreadRef(panelEnvironmentId, panelThreadId);
  const view = peerLinkEnvironment.threadView(
    targetOf({ viaEnvironmentId, environmentId, threadId }),
  );
  return Atom.make((get) => {
    const live = get(view);
    const title = AsyncResult.getOrElse(live, () => null)?.thread.projection?.thread.title;
    if (title && panelRef !== null) {
      useRightPanelStore.getState().setLinkedThreadTitle(panelRef, surfaceId, title);
    }
    return live;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`linked-thread-tab-view:${key}`));
});

/**
 * The thread of `surface`, streamed through the environment that links to it, for the tab in
 * `panelRef`'s panel or, with null, the main screen. The stream runs only while `visible`; what
 * it last showed stays.
 */
export function useLinkedThreadView(
  panelRef: ScopedThreadRef | null,
  surface: Pick<LinkedThreadSurface, "id" | "viaEnvironmentId" | "environmentId" | "threadId">,
  visible: boolean,
) {
  const key: TabKey = [
    panelRef?.environmentId ?? null,
    panelRef?.threadId ?? null,
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
 * environment can get a pairing for this client: the thread then opens there, in place of the
 * read-only view. Otherwise the add-environment dialog opens for that machine. `panelRef` is the
 * thread whose panel shows the read, or null on the main screen.
 */
export function useConnectLinkedEnvironment(
  panelRef: ScopedThreadRef | null,
  surface: LinkedThreadSurface,
) {
  const navigate = useNavigate();
  const router = useRouter();
  const setPrefill = useAtomSet(addEnvironmentPrefillAtom);
  const mayPair = useAtomValue(
    peerLinkEnvironment.pairClient.permissionAtom(surface.viaEnvironmentId),
  );
  const quiet = { reportFailure: false, reportDefect: false } as const;
  const requestPairing = useAtomCommand(peerLinkEnvironment.pairClient, quiet);
  const reaches = useAtomCommand(reachesEnvironment, quiet);
  const pair = useAtomCommand(connectPairing, quiet);
  const [state, setState] = useAtom(
    linkedEnvironmentConnectAtom(
      `${panelRef === null ? "main" : scopedThreadKey(panelRef)}:${surface.id}`,
    ),
  );
  const addWithCode = (prefill: AddEnvironmentPrefill) => {
    setPrefill(prefill);
    void navigate({ to: "/settings/connections" });
  };
  const connect = async () => {
    setState({ phase: "connecting" });
    const startedOn = router.state.location.href;
    // Pairing takes a moment; a user who has gone elsewhere since is not moved again.
    const stayed = () => router.state.location.href === startedOn;
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
      if (panelRef !== null) useRightPanelStore.getState().closeSurface(panelRef, surface.id);
      if (!stayed()) return outcome;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(surface.environmentId, surface.threadId)),
        // The read-only page has nothing left to go back to.
        replace: panelRef === null,
      });
      return outcome;
    }
    const prefill = {
      environmentId: surface.environmentId,
      label: outcome.label,
      host: outcome.host,
    };
    setState({ phase: "manual", prefill });
    if (stayed()) addWithCode(prefill);
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
