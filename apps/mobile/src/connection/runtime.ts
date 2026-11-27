import { Connection, EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { FoundationHotModule } from "../lib/foundation-fast-refresh";
import { hotSwappableAtomRuntime } from "../lib/hot-swappable-atom-runtime";
import * as Runtime from "../lib/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { recordConnectionDiagnostic } from "./diagnostics";
import * as BackgroundActivity from "./background-activity";
import * as ConnectionPlatform from "./platform";

/** Mirrors every supervisor phase change into the device connection log. */
const connectionDiagnosticsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const tracked = new Set<EnvironmentId>();
    yield* Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach((entries) =>
        Effect.forEach(
          [...entries].filter(([environmentId]) => !tracked.has(environmentId)),
          ([environmentId, entry]) => {
            tracked.add(environmentId);
            return registry.stateChanges(environmentId).pipe(
              Stream.runForEach((state) =>
                Effect.sync(() =>
                  recordConnectionDiagnostic(
                    "connection",
                    `${entry.target.label}: ${state.phase}${state.stage ? `/${state.stage}` : ""} attempt=${state.attempt} gen=${state.generation} net=${state.network}${
                      state.lastFailure ? ` failure=${state.lastFailure.detail}` : ""
                    }`,
                  ),
                ),
              ),
              Effect.ignore,
              Effect.forkScoped,
            );
          },
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const layerProvidedConnectionPlatform = ConnectionPlatform.layer.pipe(Layer.provide(Runtime.layer));

const layerSnapshotLoader = Layer.mergeAll(
  PullRequestDiffLoader.layer,
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof layerSnapshotLoader
  | typeof Runtime.layer
  | typeof ConnectionPlatform.layer
  | typeof BackgroundActivity.layerObserver
  | typeof BackgroundActivity.layerReporter;

const layerProvidedClientConnection = layerSnapshotLoader.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      usageLimitSources: true,
      usageLimitsCommand: true,
      providerCatalogsOnDemand: true,
      providerCatalogDigests: true,
      providerStatusDeltas: true,
      // Halves idle pings. The timeout is checked on ping ticks, after an unanswered ping
      // and 15 s with no frame: within 25 s of the last frame (20 s at the 5 s default),
      // and a host stalled for 10 s can lose the socket (15 s at the default).
      pingInterval: "10 seconds",
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Runtime.layer,
      layerProvidedConnectionPlatform,
      BackgroundActivity.layerObserver,
    ),
  ),
);

const layerConnection = Layer.merge(
  BackgroundActivity.layerReporter,
  connectionDiagnosticsLayer,
).pipe(Layer.provideMerge(layerProvidedClientConnection));

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = hotSwappableAtomRuntime({
  id: "t3.mobile.connection-runtime",
  hotModule: typeof module === "undefined" ? undefined : module.hot,
  registry: appAtomRegistry,
  layer: layerConnection,
});
