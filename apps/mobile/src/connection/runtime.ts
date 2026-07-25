import { Connection } from "@t3tools/client-runtime/connection";
import { shellSnapshotLoaderLayer } from "@t3tools/client-runtime/state/shell";
import { threadSnapshotLoaderLayer } from "@t3tools/client-runtime/state/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayers = Layer.mergeAll(
  shellSnapshotLoaderLayer,
  threadSnapshotLoaderLayer,
).pipe(Layer.provide(runtimeContextLayer));

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof shellSnapshotLoaderLayer
  | typeof threadSnapshotLoaderLayer;

const connectionLayer = Connection.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(runtimeContextLayer, providedConnectionPlatformLayer, snapshotLoaderLayers),
  ),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
