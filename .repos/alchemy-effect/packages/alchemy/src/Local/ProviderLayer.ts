/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Layer from "effect/Layer";
import { AlchemyContext } from "../AlchemyContext.ts";

/**
 * Returns a layer that selects the live or local provider based on the `AlchemyContext.dev` flag.
 */
export const select = <
  LayerLive extends Layer.Layer<any, any, any>,
  LayerLocal extends Layer.Layer<any, any, any>,
>(input: {
  live: () => LayerLive;
  local: () => LayerLocal;
}): Layer.Layer<
  Layer.Success<LayerLive | LayerLocal>,
  Layer.Error<LayerLive | LayerLocal>,
  Layer.Services<LayerLive | LayerLocal> | AlchemyContext
> =>
  Layer.unwrap(
    AlchemyContext.useSync((context) =>
      context.dev ? input.local() : input.live(),
    ),
  );
