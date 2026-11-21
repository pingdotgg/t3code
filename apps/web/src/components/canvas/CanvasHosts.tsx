import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type CanvasHostRequest,
  type CanvasHostResponse,
  type CanvasHostScreenshot,
  type EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import type { AppRouter } from "~/router";
import { canvasEnvironment } from "~/state/canvas";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { definePluginComponent } from "~/plugins/features";

import { bytesToBase64 } from "./canvasImport";
import { followCanvasHostRequests } from "./canvasRpc";
import {
  findMountedCanvasEngine,
  getMountedCanvasVersion,
  hasVisibleCanvasThreadHost,
  isCanvasPanelMounted,
  mountedCanvasDocumentIds,
  subscribeMountedCanvasDocuments,
  visibleCanvasThreadIds,
} from "./canvasDocumentStore";

/** Stable for this window; a reconnect with the same id replaces the old host. */
const CANVAS_CLIENT_ID = `canvas-${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/**
 * Lets agents reach canvases this window shows: screenshots render with the
 * mounted engine, and open requests add the canvas tab to the thread's panel.
 */
export const CanvasHosts = definePluginComponent(
  "component:components/canvas/CanvasHosts",
  PluginOriginalCanvasHosts,
);

function PluginOriginalCanvasHosts(props: {
  readonly environmentId: EnvironmentId;
  readonly router: AppRouter;
}) {
  const { environmentId, router } = props;
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const respond = useAtomCommand(canvasEnvironment.respondToHostRequest, {
    reportFailure: false,
  });
  const updateHost = useAtomCommand(canvasEnvironment.updateHost, { reportFailure: false });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's canvas host request stream for this environment and answers its requests
  useEffect(() => {
    let activeConnectionId: string | null = null;
    let generation = new AbortController();
    const reply = (
      connectionId: string,
      response: Omit<CanvasHostResponse, "clientId" | "connectionId">,
    ) => {
      if (connectionId !== activeConnectionId) return;
      void respond({
        environmentId,
        input: { clientId: CANVAS_CLIENT_ID, connectionId, ...response },
      });
    };
    const stopFollowing = followCanvasHostRequests(
      environmentId,
      { clientId: CANVAS_CLIENT_ID },
      (event) => {
        if (event.type === "connected") {
          generation.abort();
          generation = new AbortController();
          activeConnectionId = event.connectionId;
          setConnectionId(event.connectionId);
          return;
        }
        const connectionId = activeConnectionId;
        const signal = generation.signal;
        if (connectionId === null) return;
        void handleCanvasHostRequest(environmentId, event.request, router, signal)
          .then(async (screenshot) => {
            if (signal.aborted || connectionId !== activeConnectionId) return;
            if (event.request.type === "open") {
              const result = await updateHost({
                environmentId,
                input: {
                  clientId: CANVAS_CLIENT_ID,
                  connectionId,
                  focused: document.hasFocus() && document.visibilityState === "visible",
                  mountedDocumentIds: mountedCanvasDocumentIds(environmentId),
                  threadIds: canvasThreadHostIds(environmentId, router),
                },
              });
              if (result._tag === "Failure")
                throw new Error("Unable to register the opened canvas host.");
              assertCanvasThreadCurrent(environmentId, event.request.threadId, router);
            }
            if (signal.aborted) return;
            reply(connectionId, {
              requestId: event.request.requestId,
              ok: true,
              ...(screenshot ? { screenshot } : {}),
            });
          })
          .catch((error: unknown) =>
            reply(connectionId, {
              requestId: event.request.requestId,
              ok: false,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            }),
          );
      },
    );
    return () => {
      activeConnectionId = null;
      generation.abort();
      stopFollowing();
    };
  }, [environmentId, respond, router, updateHost]);

  const mountedVersion = useSyncExternalStore(
    subscribeMountedCanvasDocuments,
    getMountedCanvasVersion,
  );
  const mountedKey =
    mountedVersion >= 0 ? mountedCanvasDocumentIds(environmentId).join("\u0000") : "";
  const visibleThreadKey =
    mountedVersion >= 0 ? visibleCanvasThreadIds(environmentId).join("\u0000") : "";
  // The route and visible embedded conversations can each host their own canvas.
  const routedThreadId = useRouterState({
    router,
    select: (state) => {
      const ref = resolveThreadRouteRef(state.matches.at(-1)?.params ?? {});
      return ref?.environmentId === environmentId ? ref.threadId : null;
    },
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports mounted canvases, visible threads and window focus to the server host registry and listens for focus changes
  useEffect(() => {
    if (!connectionId) return;
    const report = () => {
      void updateHost({
        environmentId,
        input: {
          clientId: CANVAS_CLIENT_ID,
          connectionId,
          focused: document.hasFocus() && document.visibilityState === "visible",
          mountedDocumentIds: mountedKey ? mountedKey.split("\u0000") : [],
          threadIds: [
            ...new Set([
              ...(visibleThreadKey
                ? visibleThreadKey.split("\u0000").map((id) => ThreadId.make(id))
                : []),
              ...(routedThreadId ? [routedThreadId] : []),
            ]),
          ].toSorted(),
        },
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, [connectionId, environmentId, mountedKey, routedThreadId, updateHost, visibleThreadKey]);

  return null;
}

async function handleCanvasHostRequest(
  environmentId: EnvironmentId,
  request: CanvasHostRequest,
  router: AppRouter,
  signal: AbortSignal,
): Promise<CanvasHostScreenshot | null> {
  switch (request.type) {
    case "open": {
      assertCanvasThreadCurrent(environmentId, request.threadId, router);
      const ref = scopeThreadRef(environmentId, request.threadId);
      if (request.documentId) {
        useRightPanelStore.getState().openCanvas(ref, request.documentId);
      } else {
        useRightPanelStore.getState().open(ref, "canvas");
      }
      const surface = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
      if (surface?.kind !== "canvas") throw new Error("The canvas panel could not be opened.");
      await waitForCanvasPanel(ref, surface.documentId, router, signal);
      return null;
    }
    case "screenshot": {
      const engine = findMountedCanvasEngine(environmentId, request.documentId);
      if (!engine) throw new Error("The canvas is no longer open in this window.");
      const blob = await engine.renderToBlob({
        ...(request.nodeId ? { nodeId: request.nodeId } : {}),
        scale: request.scale,
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // PNG IHDR: width and height are big-endian u32 at bytes 16 and 20.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        pngBase64: bytesToBase64(bytes),
        width: bytes.byteLength >= 24 ? view.getUint32(16) : 0,
        height: bytes.byteLength >= 24 ? view.getUint32(20) : 0,
      };
    }
  }
}

function canvasThreadHostIds(environmentId: EnvironmentId, router: AppRouter) {
  const current = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
  const ids = new Set(visibleCanvasThreadIds(environmentId));
  if (current?.environmentId === environmentId) ids.add(current.threadId);
  return [...ids].toSorted();
}

function assertCanvasThreadCurrent(
  environmentId: EnvironmentId,
  threadId: string,
  router: AppRouter,
) {
  const current = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
  if (
    (current?.environmentId !== environmentId || current.threadId !== threadId) &&
    !hasVisibleCanvasThreadHost(environmentId, threadId)
  ) {
    throw new Error("Open the requested thread in this client before opening its canvas.");
  }
}

/** Resolve only after the visible panel and screenshot engine have mounted, without polling. */
function waitForCanvasPanel(
  ref: ScopedThreadRef,
  documentId: string | null,
  router: AppRouter,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe: (() => void)[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      for (const stop of unsubscribe) stop();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("The canvas host connection was replaced."));
    const check = () => {
      if (signal.aborted) return abort();
      try {
        assertCanvasThreadCurrent(ref.environmentId, ref.threadId, router);
        const panels = useRightPanelStore.getState().byThreadKey;
        const surface = selectActiveRightPanelSurface(panels, ref);
        if (
          !selectThreadRightPanelState(panels, ref).isOpen ||
          surface?.kind !== "canvas" ||
          surface.documentId !== documentId
        ) {
          return finish(new Error("The requested canvas is no longer the active panel."));
        }
        if (
          isCanvasPanelMounted(ref, documentId) &&
          (documentId === null || findMountedCanvasEngine(ref.environmentId, documentId) !== null)
        )
          finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    unsubscribe.push(subscribeMountedCanvasDocuments(check));
    unsubscribe.push(useRightPanelStore.subscribe(check));
    unsubscribe.push(router.subscribe("onResolved", check));
    signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(
      () => finish(new Error("The canvas editor did not become ready in time.")),
      15_000,
    );
    check();
  });
}
