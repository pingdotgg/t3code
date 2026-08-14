import { resolveTcpPortForwardSocketUrl } from "@t3tools/client-runtime/authorization";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { useEffect } from "react";

import { runtime } from "../../lib/runtime";
import { readCurrentPreparedConnection } from "../../state/session";
import {
  isMissingPortForwardEnvironment,
  portForwardAuthorizationErrorMessage,
} from "./desktopPortForwardAuthorization";

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
          return runtime.runPromiseExit(
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
        .then((result) => {
          if (result === undefined) return;
          if (Exit.isSuccess(result)) {
            return bridge.resolveAuthorization(request.requestId, result.value);
          }
          return bridge.resolveAuthorization(
            request.requestId,
            null,
            portForwardAuthorizationErrorMessage(Cause.squash(result.cause)),
          );
        })
        .catch((cause) => {
          // Authorization requests used to be broadcast to every desktop
          // renderer. Old windows that do not own this environment must stay
          // silent so they cannot race the connected renderer's response.
          if (isMissingPortForwardEnvironment(cause)) return;
          return bridge
            .resolveAuthorization(
              request.requestId,
              null,
              portForwardAuthorizationErrorMessage(cause),
            )
            .catch(() => undefined);
        });
    });
  }, []);

  return null;
}
