import {
  type ExecutionEnvironmentCapabilities,
  type PluginView,
  type PluginViewBundleInput,
  type PluginViewCallInput,
  type PluginViewProblem,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { requestIfSupported, subscribe } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** One environment's plugin views, or `unsupported` for a server that cannot serve them. */
export type PluginViewsView =
  | { readonly _tag: "unsupported" }
  | {
      readonly _tag: "available";
      readonly views: ReadonlyArray<PluginView>;
      readonly problems: ReadonlyArray<PluginViewProblem>;
    };

const supportsPluginViews = (
  capabilities: Pick<ExecutionEnvironmentCapabilities, "pluginViews"> | null | undefined,
) => capabilities?.pluginViews === true;

const UNSUPPORTED: PluginViewsView = { _tag: "unsupported" };

/**
 * Follows the environment's sessions and checks each server's capability
 * before subscribing, so a server without views never receives a view call.
 * A host mounts only views in the latest `available` frame and tears down a
 * mount whose `(installationId, generation, viewId)` leaves it.
 */
const pluginViewsStream = Stream.unwrap(
  EnvironmentSupervisor.EnvironmentSupervisor.pipe(
    Effect.map((supervisor) =>
      SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) =>
              Stream.unwrap(
                session.initialConfig.pipe(
                  Effect.map((config) =>
                    supportsPluginViews(config.environment.capabilities)
                      ? subscribe(WS_METHODS.pluginViewsSubscribe, {}).pipe(
                          Stream.map((snapshot): PluginViewsView => ({
                            _tag: "available",
                            views: snapshot.views,
                            problems: snapshot.problems,
                          })),
                        )
                      : Stream.succeed(UNSUPPORTED),
                  ),
                  // A session that never delivered its config has nothing to show yet.
                  Effect.orElseSucceed(() => Stream.empty),
                ),
              ),
          }),
        ),
      ),
    ),
  ),
);

/** The consented bytes of one view generation, from a server that serves views. */
export const readPluginViewBundle = (input: PluginViewBundleInput) =>
  requestIfSupported(WS_METHODS.pluginViewsReadBundle, input, supportsPluginViews);

/**
 * One call from a mounted view into its plugin. The host builds `input` from
 * its own binding of the mount, never from the view's message.
 */
export const callPluginView = (input: PluginViewCallInput) =>
  requestIfSupported(WS_METHODS.pluginViewsCall, input, supportsPluginViews);

export function createPluginViewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** The views the environment's enabled plugins offer now. */
    views: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugin-views:views",
      subscribe: (_input: Record<string, never>) => pluginViewsStream,
    }),
    /** A view's bundle. Keyed by environment, installation, generation and view, so it never goes stale. */
    bundle: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:plugin-views:bundle",
      execute: readPluginViewBundle,
      staleTimeMs: Number.POSITIVE_INFINITY,
    }),
  };
}
