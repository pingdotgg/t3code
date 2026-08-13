import { resolveTcpPortForwardSocketUrl } from "@t3tools/client-runtime/authorization";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { runtime } from "../../lib/runtime";
import { readCurrentPreparedConnection } from "../../state/session";

export function DesktopPortForwardAuthorizationBridge() {
  useEffect(() => {
    const bridge = window.desktopBridge?.portForward;
    if (bridge === undefined) return;

    return bridge.onAuthorizationRequest((request) => {
      void readCurrentPreparedConnection(request.environmentId)
        .then((prepared) => {
          if (prepared === null) {
            // Authorization requests are broadcast to every desktop window.
            // Only the renderer that owns a live connection should answer.
            return;
          }
          return runtime.runPromise(
            Effect.gen(function* () {
              const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
              return yield* resolveTcpPortForwardSocketUrl({
                prepared,
                signer,
                remoteHost: request.remoteHost,
                remotePort: request.remotePort,
              });
            }),
          );
        })
        .then((socketUrl) => {
          if (socketUrl !== undefined) {
            return bridge.resolveAuthorization(request.requestId, socketUrl);
          }
        })
        .catch((cause) =>
          bridge
            .resolveAuthorization(
              request.requestId,
              null,
              cause instanceof Error ? cause.message : String(cause),
            )
            .catch(() => undefined),
        );
    });
  }, []);

  return null;
}
