import { Connection } from "@t3tools/client-runtime/connection";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer: Layer.Layer<
  Layer.Success<typeof connectionPlatformLayer>,
  Layer.Error<typeof connectionPlatformLayer>
> = connectionPlatformLayer.pipe(Layer.provide(runtimeContextLayer));

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof runtimeContextLayer
  | typeof providedConnectionPlatformLayer;

export const connectionLayer: Layer.Layer<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Connection.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(runtimeContextLayer, providedConnectionPlatformLayer)),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<typeof connectionLayer>,
  Layer.Error<typeof connectionLayer>
> = Atom.runtime(connectionLayer);
