import {
  AuthComputerHostScope,
  type ComputerHostConnectInput,
  type ComputerHostFrame,
  type ComputerHostReply,
  type DesktopBridge,
  type DesktopComputerCall,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import {
  getClientSettings,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
  updateClientSettings,
} from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession, readEnvironmentScope } from "~/state/session";

type ComputerBridge = NonNullable<DesktopBridge["computerHost"]>;

/** How the desktop's offer of this computer to one environment currently stands. */
export type DesktopComputerHostStatus =
  | { readonly phase: "off" }
  | { readonly phase: "starting" }
  | { readonly phase: "hosting" }
  /** Another environment holds this computer, so this one waits its turn. */
  | { readonly phase: "waiting"; readonly detail: string }
  /** This connection cannot host: it was paired before hosting existed, so it lacks the grant. */
  | { readonly phase: "denied"; readonly detail: string }
  /** macOS cannot host here, or the helper did not start. */
  | { readonly phase: "unavailable"; readonly detail: string };

const OFF: DesktopComputerHostStatus = { phase: "off" };
const RECONNECT_DELAY = "2 seconds";
const WAIT_FOR_COMPUTER_DELAY = "5 seconds";

const statuses = new Map<EnvironmentId, DesktopComputerHostStatus>();
const listeners = new Set<() => void>();

const setStatus = (environmentId: EnvironmentId, status: DesktopComputerHostStatus): void => {
  const current = statuses.get(environmentId);
  const same =
    current?.phase === status.phase &&
    ("detail" in current ? current.detail : "") === ("detail" in status ? status.detail : "");
  if (same) return;
  statuses.set(environmentId, status);
  for (const listener of listeners) listener();
};

function readDesktopComputerHostStatus(
  environmentId: EnvironmentId | null,
): DesktopComputerHostStatus {
  return (environmentId === null ? undefined : statuses.get(environmentId)) ?? OFF;
}

function subscribeDesktopComputerHostStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDesktopComputerHostStatus(
  environmentId: EnvironmentId | null,
): DesktopComputerHostStatus {
  return useSyncExternalStore(subscribeDesktopComputerHostStatus, () =>
    readDesktopComputerHostStatus(environmentId),
  );
}

export function setDesktopComputerHostOffered(
  environmentId: EnvironmentId,
  offered: boolean,
): Promise<void> {
  const environments = { ...getClientSettings().computerHostEnvironments };
  if (offered) environments[environmentId] = true;
  else delete environments[environmentId];
  return updateClientSettings({ computerHostEnvironments: environments });
}

/**
 * The renderer's half of the desktop computer host. The main process runs the helper; this side holds the
 * environment's authenticated connection, so it relays that environment's host frames down and the helper's
 * questions up. One environment holds the computer at a time, because there is one screen and one task.
 */
export function startDesktopComputerHost(): () => void {
  const bridge = window.desktopBridge?.computerHost;
  if (bridge === undefined) return () => undefined;

  const unmountRuntime = appAtomRegistry.mount(connectionAtomRuntime);
  const hostIds = new Map<EnvironmentId, string>();
  const unsubscribes = new Set<() => void>();
  const sessionUnsubscribes = new Map<EnvironmentId, () => void>();
  let relay: { readonly environmentId: EnvironmentId; readonly abort: AbortController } | null =
    null;
  let stopped = false;

  const stopRelay = () => {
    const current = relay;
    relay = null;
    hostIds.clear();
    if (current === null) return;
    current.abort.abort();
    setStatus(current.environmentId, OFF);
    void bridge.disconnect(current.environmentId).catch(() => undefined);
  };

  const reconcile = () => {
    if (stopped) return;
    const offered = Object.entries(getClientSettings().computerHostEnvironments)
      .filter(([, enabled]) => enabled)
      .map(([environmentId]) => environmentId as EnvironmentId);
    const catalog = [...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys()];
    // A connection paired after this started is watched too: its grant arrives without a reload.
    for (const environmentId of catalog) {
      if (sessionUnsubscribes.has(environmentId)) continue;
      sessionUnsubscribes.set(
        environmentId,
        appAtomRegistry.subscribe(environmentSessionState(environmentId), reconcile, {
          immediate: false,
        }),
      );
    }
    for (const [environmentId, unsubscribe] of sessionUnsubscribes) {
      if (catalog.includes(environmentId)) continue;
      unsubscribe();
      sessionUnsubscribes.delete(environmentId);
    }
    for (const environmentId of offered) {
      if (!catalog.includes(environmentId)) {
        setStatus(environmentId, OFF);
      } else if (!readEnvironmentScope(environmentId, AuthComputerHostScope)) {
        setStatus(environmentId, {
          phase: "denied",
          detail: "Pair this connection again to let it use this computer.",
        });
      } else if (relay?.environmentId !== environmentId) {
        setStatus(environmentId, { phase: "waiting", detail: "Waiting to offer this computer." });
      }
    }

    const chosen = offered.find(
      (environmentId) =>
        catalog.includes(environmentId) &&
        readEnvironmentScope(environmentId, AuthComputerHostScope),
    );
    if (relay !== null && relay.environmentId === chosen) return;
    stopRelay();
    if (chosen === undefined) return;
    const context = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(connectionAtomRuntime)));
    if (context === null) return;

    const abort = new AbortController();
    relay = { environmentId: chosen, abort };
    setStatus(chosen, { phase: "starting" });
    void Effect.runPromiseWith(context)(
      serve(chosen, bridge, hostIds).pipe(
        Effect.ensuring(Effect.promise(() => bridge.disconnect(chosen))),
        // A host stream that ends or fails is offered again; only stopping this relay ends it.
        Effect.retry({ schedule: Schedule.spaced(RECONNECT_DELAY) }),
      ),
      { signal: abort.signal },
    ).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      setStatus(chosen, {
        phase: "unavailable",
        detail: error instanceof Error ? error.message : "The computer host stopped.",
      });
    });
    trackEnvironment(abort.signal, bridge, chosen, hostIds);
  };

  const trackEnvironment = (
    signal: AbortSignal,
    computer: ComputerBridge,
    environmentId: EnvironmentId,
    ids: Map<EnvironmentId, string>,
  ) => {
    const unsubscribe = computer.onCall((call) => {
      if (call.environmentId !== environmentId || signal.aborted) return;
      const hostId = ids.get(environmentId);
      if (hostId === undefined) return;
      const context = Option.getOrNull(
        AsyncResult.value(appAtomRegistry.get(connectionAtomRuntime)),
      );
      if (context === null) return;
      void Effect.runPromiseWith(context)(answerCall(call, hostId, computer)).catch(
        () => undefined,
      );
    });
    signal.addEventListener("abort", unsubscribe, { once: true });
  };

  const track = (unsubscribe: () => void) => {
    unsubscribes.add(unsubscribe);
  };

  track(subscribeClientSettings(reconcile));
  track(subscribeClientSettingsHydration(reconcile));
  track(appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, reconcile));
  reconcile();

  return () => {
    stopped = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes.clear();
    for (const unsubscribe of sessionUnsubscribes.values()) unsubscribe();
    sessionUnsubscribes.clear();
    stopRelay();
    unmountRuntime();
  };
}

/** Session state moves when a connection re-pairs, which is when a missing grant can appear. */
const environmentSessionState = (environmentId: EnvironmentId) =>
  environmentSession.sessionStateAtom(environmentId);

/** Runs the host for one environment until its stream ends. */
const serve = Effect.fn("web.computerHost.serve")(function* (
  environmentId: EnvironmentId,
  bridge: ComputerBridge,
  hostIds: Map<EnvironmentId, string>,
) {
  const offer = yield* offerComputer(environmentId, bridge);
  if (!offer.ok) {
    setStatus(environmentId, { phase: "unavailable", detail: offer.reason });
    return yield* Effect.never;
  }
  setStatus(environmentId, { phase: "starting" });
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  return yield* registry.followStream(environmentId, hostFrames(offer.hello)).pipe(
    Stream.runForEach(([session, frame]) =>
      relayFrame(environmentId, session, frame, bridge, hostIds),
    ),
    // A host stream the environment ends is offered again rather than leaving this Mac unhosted.
    Effect.andThen(Effect.fail("host-stream-ended" as const)),
  );
});

/** Waits while another environment holds this computer; a stated refusal ends the offer. */
const offerComputer = Effect.fn("web.computerHost.offerComputer")(function* (
  environmentId: EnvironmentId,
  bridge: ComputerBridge,
) {
  for (;;) {
    const offer = yield* Effect.promise(() => bridge.prepare(environmentId));
    if (offer.ok || offer.retry === "never") return offer;
    setStatus(environmentId, { phase: "waiting", detail: offer.reason });
    yield* Effect.sleep(WAIT_FOR_COMPUTER_DELAY);
  }
});

/** The environment's host stream, across reconnects: a new session re-opens it with the same hello. */
const hostFrames = (hello: ComputerHostConnectInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const sessions = Stream.concat(
        Stream.fromEffect(SubscriptionRef.get(supervisor.session)),
        SubscriptionRef.changes(supervisor.session),
      );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) =>
              session.client[WS_METHODS.computerHostConnect](hello).pipe(
                Stream.map((frame) => [session, frame] as const),
              ),
          }),
        ),
      );
    }),
  );

const relayFrame = Effect.fn("web.computerHost.relayFrame")(function* (
  environmentId: EnvironmentId,
  session: RpcSession,
  frame: ComputerHostFrame,
  bridge: ComputerBridge,
  hostIds: Map<EnvironmentId, string>,
) {
  if (frame.kind === "welcome") {
    hostIds.set(environmentId, frame.hostId);
    setStatus(environmentId, { phase: "hosting" });
  }
  const reply = yield* Effect.tryPromise({
    try: () => bridge.sendFrame({ environmentId, frame }),
    catch: () => "main-unavailable" as const,
  }).pipe(Effect.orElseSucceed((): ComputerHostReply | null => null));
  const hostId = hostIds.get(environmentId);
  if (reply === null || hostId === undefined) return;
  yield* session.client[WS_METHODS.computerHostRespond]({ hostId, reply }).pipe(Effect.ignore);
});

/**
 * Answers one call the helper made. The environment's server decides each step, so a failed call fails the
 * step instead of leaving the helper waiting.
 */
const answerCall = Effect.fn("web.computerHost.answerCall")(function* (
  call: DesktopComputerCall,
  hostId: string,
  bridge: ComputerBridge,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const detail = (error: unknown) => (error instanceof Error ? error.message : String(error));
  switch (call.type) {
    case "closed":
      break;
    case "access":
      yield* registry
        .run(
          call.environmentId,
          request(WS_METHODS.computerHostAccess, { hostId, access: call.access }),
        )
        .pipe(Effect.ignore);
      break;
    case "event":
      yield* registry
        .run(
          call.environmentId,
          request(WS_METHODS.computerHostEvent, {
            hostId,
            taskId: call.taskId,
            event: call.event,
          }),
        )
        .pipe(Effect.ignore);
      break;
    case "authorize": {
      const grant = yield* registry
        .run(
          call.environmentId,
          request(WS_METHODS.computerHostAuthorize, {
            hostId,
            taskId: call.taskId,
            step: call.step,
            observation: call.observation,
            action: call.action,
          }),
        )
        .pipe(
          Effect.catch((error) => Effect.succeed({ ok: false as const, denied: detail(error) })),
        );
      yield* Effect.promise(() => bridge.answer({ type: "grant", callId: call.callId, grant }));
      return;
    }
    case "decide": {
      const answers = yield* registry
        .run(
          call.environmentId,
          request(WS_METHODS.computerHostDecide, {
            hostId,
            taskId: call.taskId,
            state: call.state,
            questions: call.questions,
          }),
        )
        .pipe(Effect.orElseSucceed(() => ({})));
      yield* Effect.promise(() => bridge.answer({ type: "answers", callId: call.callId, answers }));
      return;
    }
  }
  yield* Effect.promise(() => bridge.answer({ type: "done", callId: call.callId }));
});
