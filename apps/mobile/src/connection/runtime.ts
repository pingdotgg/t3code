import { Connection } from "@t3tools/client-runtime/connection";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import type { FoundationHotModule } from "../lib/foundation-fast-refresh";
import { hotSwappableAtomRuntime } from "../lib/hot-swappable-atom-runtime";
import * as Runtime from "../lib/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import * as BackgroundActivity from "./background-activity";
import * as ConnectionPlatform from "./platform";

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
      // Halves idle pings. A socket drops after two silent ticks: within 25 s of its
      // last frame (20 s at the 5 s default), or when the host stalls for 10 s (15 s).
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

const layerConnection = BackgroundActivity.layerReporter.pipe(
  Layer.provideMerge(layerProvidedClientConnection),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = hotSwappableAtomRuntime({
  id: "t3.mobile.connection-runtime",
  hotModule: typeof module === "undefined" ? undefined : module.hot,
  registry: appAtomRegistry,
  layer: layerConnection,
});
