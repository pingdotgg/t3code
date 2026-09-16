import type {
  DesktopAppConnectionDispatch,
  DesktopAppConnectionResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AtomRegistry } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { handleDesktopAppConnectionRequest } from "../../desktopAppConnection";
import { appAtomRegistry } from "../../rpc/atomRegistry";

/**
 * Answers control-socket connection requests with the renderer's own
 * environment registry. Requests run concurrently; a cancel from main or an
 * unmount (reload, sign out) aborts the fiber so no work continues for a
 * caller that already gave up.
 */
export function DesktopAppConnectionCoordinator() {
  const bridge = window.desktopBridge?.appConnection;

  useEffect(() => {
    if (bridge === undefined) return;
    const inFlight = new Map<string, AbortController>();
    let subscribed = true;

    const unsubscribeRequests = bridge.onRequest(
      ({ dispatchId, request }: DesktopAppConnectionDispatch) => {
        if (inFlight.has(dispatchId)) return;
        const controller = new AbortController();
        inFlight.set(dispatchId, controller);
        const program = Effect.gen(function* () {
          const context = yield* AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime, {
            suspendOnWaiting: true,
          });
          return yield* handleDesktopAppConnectionRequest(request).pipe(Effect.provide(context));
        });
        void Effect.runPromiseExit(program, { signal: controller.signal }).then((exit) => {
          if (inFlight.get(dispatchId) !== controller) return;
          inFlight.delete(dispatchId);
          if (!subscribed || controller.signal.aborted) return;
          const response: DesktopAppConnectionResponse = Exit.isSuccess(exit)
            ? exit.value
            : {
                version: 1,
                requestId: request.requestId,
                ok: false,
                code: "internal-error",
                message: "T3 Code could not process the connection request.",
              };
          void bridge.complete({ dispatchId, response }).catch(() => undefined);
        });
      },
    );
    const unsubscribeCancels = bridge.onCancel((dispatchId) => {
      const controller = inFlight.get(dispatchId);
      if (controller === undefined) return;
      inFlight.delete(dispatchId);
      controller.abort();
    });
    queueMicrotask(() => {
      if (subscribed) void bridge.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void bridge.setReady(false).catch(() => undefined);
      unsubscribeRequests();
      unsubscribeCancels();
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    };
  }, [bridge]);

  return null;
}
