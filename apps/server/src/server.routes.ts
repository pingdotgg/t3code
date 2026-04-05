import { Layer } from "effect";

import {
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  staticAndDevRouteLayer,
} from "./http";
import { websocketRpcRouteLayer } from "./ws";

export const makeRoutesLayer = Layer.mergeAll(
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
);
