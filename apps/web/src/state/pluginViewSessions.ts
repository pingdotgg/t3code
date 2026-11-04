import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { EnvironmentRpcSubscriptionObserver, type RpcSession } from "@t3tools/client-runtime/rpc";
import type { PluginViewsView } from "@t3tools/client-runtime/state/pluginViews";
import { type EnvironmentId, type PluginView, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type AsyncResult, Atom } from "effect/reactivity";

/**
 * An environment's plugin views as the host may act on them. `views` is the
 * latest snapshot that `session` produced, and null until it has produced
 * one. Every session change resets `views` first, so availability from an
 * earlier session never authorizes a mount or a launcher row in a later one.
 */
export interface SessionPluginViews {
  readonly session: RpcSession | null;
  readonly views: PluginViewsView | null;
}

export const NO_SESSION_VIEWS: SessionPluginViews = { session: null, views: null };

const UNSUPPORTED: PluginViewsView = { _tag: "unsupported" };

/**
 * The views `session` offers, then none once its subscription ends. Bound to
 * this one session rather than the recovering subscription helper, which
 * swallows a lost transport and would leave the last snapshot authorizing
 * mounts. The host withholds views until the next session's own snapshot.
 */
const subscribeViews = (environmentId: EnvironmentId, session: RpcSession) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const completeObservation = yield* observer.observe({
        environmentId,
        method: WS_METHODS.pluginViewsSubscribe,
        input: {},
      });
      return session.client[WS_METHODS.pluginViewsSubscribe]({}).pipe(
        Stream.ensuring(completeObservation),
      );
    }),
  ).pipe(
    Stream.map((snapshot): SessionPluginViews => ({
      session,
      views: { _tag: "available", views: snapshot.views, problems: snapshot.problems },
    })),
    Stream.catchCause((cause) =>
      Stream.fromEffect(
        Effect.logWarning("Plugin views subscription failed; waiting for the next session.", {
          cause: Cause.pretty(cause),
          environmentId,
        }),
      ).pipe(Stream.drain),
    ),
    Stream.concat(Stream.succeed<SessionPluginViews>({ session, views: null })),
    // Only a session change brings views back.
    Stream.concat(Stream.never),
  );

/** One session's views, starting empty; a server without views gets no request. */
const viewsOfSession = (environmentId: EnvironmentId, session: RpcSession) =>
  Stream.succeed<SessionPluginViews>({ session, views: null }).pipe(
    Stream.concat(
      Stream.unwrap(
        session.initialConfig.pipe(
          // Capabilities are fixed for a server process, so a session's initial config holds.
          Effect.map((config) =>
            config.environment.capabilities?.pluginViews === true
              ? subscribeViews(environmentId, session)
              : Stream.succeed<SessionPluginViews>({ session, views: UNSUPPORTED }),
          ),
          // A session that never delivered its config stays empty.
          Effect.orElseSucceed(() => Stream.empty),
        ),
      ),
    ),
  );

const viewsOfSessions = (environmentId: EnvironmentId) =>
  Stream.unwrap(
    EnvironmentSupervisor.EnvironmentSupervisor.pipe(
      Effect.map((supervisor) =>
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.switchMap(
            Option.match({
              onNone: () => Stream.succeed(NO_SESSION_VIEWS),
              onSome: (session) => viewsOfSession(environmentId, session),
            }),
          ),
        ),
      ),
    ),
  );

/** Follows the environment's registration too: a removed environment has no session. */
const viewsOfEnvironment = (environmentId: EnvironmentId) =>
  Stream.unwrap(
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.map((registry) =>
        Stream.concat(
          Stream.fromEffect(SubscriptionRef.get(registry.entries)),
          SubscriptionRef.changes(registry.entries),
        ).pipe(
          Stream.map((entries) => entries.has(environmentId)),
          Stream.changes,
          Stream.switchMap((registered) =>
            Stream.succeed(NO_SESSION_VIEWS).pipe(
              Stream.concat(
                registered
                  ? registry.followStream(environmentId, viewsOfSessions(environmentId))
                  : Stream.empty,
              ),
            ),
          ),
        ),
      ),
    ),
  );

export function createSessionPluginViewsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(viewsOfEnvironment(environmentId), { initialValue: NO_SESSION_VIEWS })
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:plugin-views:session-views:${environmentId}`),
      ),
  );
}

/** A failed atom withholds views too; an earlier success is never reused. */
export function currentSessionPluginViews(
  result: AsyncResult.AsyncResult<SessionPluginViews, unknown>,
): SessionPluginViews {
  return result._tag === "Success" ? result.value : NO_SESSION_VIEWS;
}

const NO_VIEWS: ReadonlyArray<PluginView> = [];

/** The views this client can place in the right panel; other placements are skipped. */
export function sidePanelPluginViews(views: PluginViewsView | null): ReadonlyArray<PluginView> {
  if (views?._tag !== "available") return NO_VIEWS;
  const placed = views.views.filter((view) => view.placement === "side-panel");
  return placed.length === views.views.length ? views.views : placed;
}
