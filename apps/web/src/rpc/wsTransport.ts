import {
  WsTransport as BaseWsTransport,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolSocketUrlProvider,
  type WsTransportOptions,
} from "@t3tools/client-runtime";
import { createWsRpcProtocolLayer as createSharedWsRpcProtocolLayer } from "@t3tools/client-runtime";

import { ClientTracingLive } from "../observability/clientTracing";
import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
} from "./wsConnectionState";

function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
) {
  return createSharedWsRpcProtocolLayer(url, handlers, {
    telemetryLifecycle: {
      onAttempt: recordWsConnectionAttempt,
      onOpen: recordWsConnectionOpened,
      onError: (message) => {
        clearAllTrackedRpcRequests();
        recordWsConnectionErrored(message);
      },
      onClose: (details, context) => {
        clearAllTrackedRpcRequests();
        if (context.intentional) {
          return;
        }
        recordWsConnectionClosed(details);
      },
    },
    requestTelemetry: {
      onRequestSent: trackRpcRequestSent,
      onRequestAcknowledged: acknowledgeRpcRequest,
      onClearTrackedRequests: clearAllTrackedRpcRequests,
    },
  });
}

const webWsTransportOptions = {
  tracingLayer: ClientTracingLive,
  createProtocolLayer: createWsRpcProtocolLayer,
  onBeforeReconnect: () => clearAllTrackedRpcRequests(),
} satisfies WsTransportOptions;

export class WsTransport extends BaseWsTransport {
  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    super(url, lifecycleHandlers, webWsTransportOptions);
  }
}
