import { resolveTcpPortForwardSocketUrl } from "@t3tools/client-runtime/authorization";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

export function DesktopPortForwardAuthorizationBridge() {
  useEffect(() => {
    const bridge = window.desktopBridge?.portForward;
    if (bridge === undefined) return;

    return bridge.onAuthorizationRequest((request) => {
      const prepared = readPreparedConnection(request.environmentId);
      if (prepared === null) {
        void bridge.resolveAuthorization(request.requestId, null);
        return;
      }

      void runtime
        .runPromise(
          Effect.gen(function* () {
            const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
            return yield* resolveTcpPortForwardSocketUrl({
              prepared,
              signer,
              remoteHost: request.remoteHost,
              remotePort: request.remotePort,
            });
          }),
        )
        .then(
          (socketUrl) => bridge.resolveAuthorization(request.requestId, socketUrl),
          () => bridge.resolveAuthorization(request.requestId, null),
        )
        .catch(() => undefined);
    });
  }, []);

  return null;
}
