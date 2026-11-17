import {
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { updatePreviewServerSnapshot } from "~/previewStateStore";
import { AsyncResult } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { appAtomRegistry } from "./atomRegistry";
import { environmentCatalog } from "~/connection/catalog";
import { previewEnvironment } from "~/state/preview";
import { environmentThreadDetails } from "~/state/threads";
import { readThreadPreviewState } from "~/previewStateStore";
import { acquireBrowserSurfaceActivity } from "~/browser/browserSurfaceStore";
import { previewBridge } from "~/components/preview/previewBridge";

const decodeResizeResult = Schema.decodeUnknownSync(PreviewAutomationResizeResult);
const decodeAppearanceResult = Schema.decodeUnknownSync(PreviewAutomationSetColorSchemeResult);

/** The guest owns its lifetime; each transport connection gets a fresh host. */
export function hostDesktopTab(threadRef: ScopedThreadRef, tabId: string, runtimeTabId: string) {
  const bridge = previewBridge;
  if (!bridge?.connectTabHost || !bridge.executeTabRequest) return () => {};
  // Public CDP clients can capture at any time. An offscreen Electron guest
  // stops compositing even with background throttling disabled, so keep the
  // hosted tab paintable behind the app until its guest is released.
  const releaseSurfaceActivity = acquireBrowserSurfaceActivity(runtimeTabId);
  const connectionAtom = environmentCatalog.stateAtom(threadRef.environmentId);
  let disposed = false;
  let connected = false;
  let generation = 0;
  let abort: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let transition = Promise.resolve();
  const live = (version: number) => !disposed && connected && generation === version;
  const schedule = () => {
    const version = ++generation;
    abort?.abort();
    clearTimeout(retry);
    transition = transition
      .catch(() => undefined)
      .then(async () => {
        await bridge.disconnectTabHost?.(runtimeTabId);
        if (!live(version)) return;
        const snapshot = readThreadPreviewState(threadRef).sessions[tabId];
        if (!snapshot || snapshot.runtime === "server") return;
        const binding = {
          ...threadRef,
          tabId: snapshot.tabId,
          snapshot,
          deviceName: (await bridge.getHostDeviceName?.()) ?? "desktop",
        };
        const registration = await runAtomCommand(
          appAtomRegistry,
          previewEnvironment.desktopRegister,
          {
            environmentId: threadRef.environmentId,
            input: binding,
          },
        );
        // Registration can lose a race to another desktop. Resolve the owner
        // instead of retrying a local guest forever against that live host.
        appAtomRegistry.refresh(
          previewEnvironment.list({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          }),
        );
        if (!AsyncResult.isSuccess(registration))
          throw new Error("Desktop host registration failed.");
        const { connectionId } = registration.value;
        const streamAbort = new AbortController();
        // Even if a disconnect overtook registration, subscribe and abort so the
        // server releases the reservation instead of waiting for its expiry.
        abort = streamAbort;
        let ready = false;
        const queued: PreviewAutomationRequest[] = [];
        const deliver = async (request: PreviewAutomationRequest) => {
          if (!live(version)) return;
          let response: PreviewAutomationResponse;
          try {
            response = await bridge.executeTabRequest!(runtimeTabId, connectionId, request);
            if (!live(version)) return;
            // Publish rendering choices through the same state as the panel controls.
            // The runner has already applied the operation in its SessionControl queue.
            if (response.ok && request.operation === "resize") {
              const { setting } = decodeResizeResult(response.result);
              const resized = await runAtomCommand(appAtomRegistry, previewEnvironment.resize, {
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, tabId: request.tabId!, viewport: setting },
              });
              if (!AsyncResult.isSuccess(resized))
                throw new Error("Desktop viewport update failed.");
              if (live(version)) updatePreviewServerSnapshot(threadRef, resized.value);
            } else if (response.ok && request.operation === "setColorScheme") {
              const { colorScheme } = decodeAppearanceResult(response.result);
              const adjusted = await runAtomCommand(appAtomRegistry, previewEnvironment.adjust, {
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, tabId: request.tabId!, colorScheme },
              });
              if (!AsyncResult.isSuccess(adjusted))
                throw new Error("Desktop appearance update failed.");
              if (live(version)) updatePreviewServerSnapshot(threadRef, adjusted.value);
            }
          } catch {
            response = {
              clientId: "desktop",
              connectionId,
              requestId: request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "Desktop tab is unavailable.",
              },
            };
          }
          if (!live(version)) return;
          await runAtomCommand(appAtomRegistry, previewEnvironment.desktopRespond, {
            environmentId: threadRef.environmentId,
            input: response,
          });
        };
        void runAtomCommand(appAtomRegistry, previewEnvironment.desktopRequests, {
          environmentId: threadRef.environmentId,
          input: {
            connectionId,
            signal: streamAbort.signal,
            onEvent: async (event) => {
              if (event.type !== "request" || event.connectionId !== connectionId) return;
              // Keep reading while an action runs. The native SessionControl
              // serializes mutations and allows status reads during navigation.
              if (ready) void deliver(event.request).catch(() => undefined);
              else queued.push(event.request);
            },
          },
        }).finally(() => {
          if (live(version)) retry = setTimeout(schedule, 1_000);
        });
        if (!live(version)) {
          streamAbort.abort();
          return;
        }
        try {
          await bridge.connectTabHost!({ binding, runtimeTabId, connectionId });
          if (!live(version)) return;
          ready = true;
          for (const request of queued) void deliver(request).catch(() => undefined);
        } catch (error) {
          streamAbort.abort();
          throw error;
        }
      })
      .catch(() => {
        if (live(version)) retry = setTimeout(schedule, 1_000);
      });
  };
  const sync = () => {
    const next = Option.exists(
      AsyncResult.value(appAtomRegistry.get(connectionAtom)),
      (state) => state.phase === "connected",
    );
    if (next === connected) return;
    connected = next;
    schedule();
  };
  // Stop also revokes scripts already connected directly over CDP. Rehosting
  // keeps the user's page open, with fresh endpoints available to the next run.
  const threadAtom = environmentThreadDetails.stateAtom(threadRef);
  let stoppedRun: string | undefined;
  const syncThread = () => {
    const thread = Option.getOrUndefined(appAtomRegistry.get(threadAtom).data);
    if (!thread) return;
    const stopped =
      thread.runs.findLast((run) => run.status === "interrupted" || run.status === "cancelled")
        ?.id ?? "";
    if (stoppedRun !== undefined && stopped !== stoppedRun) schedule();
    stoppedRun = stopped;
  };
  const unsubscribeThread = appAtomRegistry.subscribe(threadAtom, syncThread);
  syncThread();
  const unsubscribe = appAtomRegistry.subscribe(connectionAtom, sync);
  sync();
  return () => {
    disposed = true;
    releaseSurfaceActivity();
    unsubscribe();
    unsubscribeThread();
    schedule();
  };
}
