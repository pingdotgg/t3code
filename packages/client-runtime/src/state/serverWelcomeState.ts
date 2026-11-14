import {
  type EnvironmentId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { type ServerConfigProjection } from "./serverConfigProjection.ts";

export function applyServerWelcomeEvent(
  current: EnvironmentServerWelcomeState,
  session: RpcSession,
  event: {
    readonly type: "welcome" | "ready" | "legacyThreadMigration";
    readonly payload: unknown;
  },
): EnvironmentServerWelcomeState {
  return event.type === "welcome" && current.currentSession === session
    ? {
        ...current,
        welcomeSession: session,
        welcome: event.payload as ServerLifecycleWelcomePayload,
      }
    : current;
}

export interface EnvironmentServerWelcomeState {
  readonly currentSession: RpcSession | null;
  readonly welcomeSession: RpcSession | null;
  readonly welcome: ServerLifecycleWelcomePayload | null;
}

export function resolveServerWelcomeState(
  state: EnvironmentServerWelcomeState,
): ServerLifecycleWelcomePayload | null {
  return state.currentSession === state.welcomeSession ? state.welcome : null;
}

export const makeEnvironmentServerWelcomeState = Effect.fn("EnvironmentServerWelcomeState.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const initialSession = Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
    const state = yield* SubscriptionRef.make<EnvironmentServerWelcomeState>({
      currentSession: initialSession,
      welcomeSession: null,
      welcome: null,
    });

    const updateWithCurrentSession = Effect.fn(
      "EnvironmentServerWelcomeState.updateWithCurrentSession",
    )(function* (
      update: (
        current: EnvironmentServerWelcomeState,
        currentSession: RpcSession | null,
      ) => EnvironmentServerWelcomeState,
    ) {
      return yield* SubscriptionRef.modifyEffect(state, (current) =>
        SubscriptionRef.get(supervisor.session).pipe(
          Effect.map(
            (latestSession) =>
              [undefined, update(current, Option.getOrNull(latestSession))] as const,
          ),
        ),
      );
    });

    yield* SubscriptionRef.changes(supervisor.session).pipe(
      Stream.runForEach(() =>
        updateWithCurrentSession((current, currentSession) => ({
          ...current,
          currentSession,
        })),
      ),
      Effect.forkScoped,
    );

    yield* subscribeDynamicWithSession(
      WS_METHODS.subscribeServerLifecycle,
      Effect.fn("EnvironmentServerWelcomeState.makeSubscribeInput")(function* (session) {
        yield* updateWithCurrentSession((current, currentSession) =>
          currentSession === session
            ? {
                ...current,
                currentSession,
                welcomeSession: session,
                welcome: null,
              }
            : { ...current, currentSession },
        );
        return {};
      }),
    ).pipe(
      Stream.runForEach(([session, event]) =>
        updateWithCurrentSession((current, currentSession) =>
          applyServerWelcomeEvent(
            {
              ...current,
              currentSession,
            },
            session,
            event,
          ),
        ),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

export function serverWelcomeStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerWelcomeState().pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(Stream.map(resolveServerWelcomeState)),
        ),
      ),
    ),
  );
}

export function resolveServerConfigValue(
  projection: ServerConfigProjection | null,
  initialConfig: ServerConfig | null,
): ServerConfig | null {
  if (
    projection?.source === "live" &&
    (initialConfig === null ||
      projection.config.environment.serverVersion === initialConfig.environment.serverVersion)
  ) {
    return projection.config;
  }
  return initialConfig ?? projection?.config ?? null;
}
