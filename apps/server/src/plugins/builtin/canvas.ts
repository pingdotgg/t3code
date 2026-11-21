import * as Layer from "effect/Layer";
import * as CanvasHostBroker from "../../canvas/CanvasHostBroker.ts";
import * as CanvasService from "../../canvas/CanvasService.ts";

export const CanvasLayerLive = CanvasService.layer.pipe(Layer.provideMerge(CanvasHostBroker.layer));
