"use client";

import type {
  DesktopPreviewTabState,
  PreviewReportStatusInput,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { setNativePreviewFocused } from "~/lib/previewFocus";
import { applyPreviewDesktopState } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import { projectDesktopPreviewState } from "./desktopPreviewState";

/**
 * Mirrors low-latency desktop state into the store and reflects navigation
 * events back to the server. Native view lifetime is owned by ElectronBrowserHost.
 */
export function usePreviewBridge(input: { threadRef: ScopedThreadRef; tabId: string }): void {
  const { threadRef, tabId } = input;
  const clearBrowserPointer = useBrowserPointerStore((state) => state.clear);
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, "preview status report");
  const bridge = previewBridge;

  // One bridge subscription does both jobs (mirror state + forward to
  // server) so the desktop bridge keeps a single listener entry per tab.
  const lastReportedUrl = useRef<string | null>(null);
  const lastReportedKind = useRef<DesktopPreviewTabState["navStatus"]["kind"] | null>(null);
  const lastDesktopNavStatus = useRef<DesktopPreviewTabState["navStatus"] | null>(null);
  useEffect(() => {
    if (!bridge || typeof window === "undefined") return;
    lastReportedUrl.current = null;
    lastReportedKind.current = null;
    lastDesktopNavStatus.current = null;
    let disposed = false;
    let latestUpdatedAt = "";
    const applyState = (changedTabId: string, state: DesktopPreviewTabState) => {
      if (changedTabId !== tabId) return;
      if (state.updatedAt < latestUpdatedAt) return;
      latestUpdatedAt = state.updatedAt;
      if (shouldClearBrowserPointer(lastDesktopNavStatus.current, state.navStatus)) {
        clearBrowserPointer(tabId);
      }
      lastDesktopNavStatus.current = state.navStatus;
      setNativePreviewFocused(tabId, state.focused);
      applyPreviewDesktopState(threadRef, tabId, projectDesktopPreviewState(state));
      const reported = buildReportInput({
        threadId: threadRef.threadId,
        tabId,
        state,
        lastReportedUrl: lastReportedUrl.current,
        lastReportedKind: lastReportedKind.current,
      });
      if (!reported) return;
      lastReportedUrl.current = reported.lastReportedUrl;
      lastReportedKind.current = reported.lastReportedKind;
      void reportStatus({
        environmentId: threadRef.environmentId,
        input: reported.input,
      });
    };
    const unsubscribe = bridge.onStateChange(applyState);
    // Event subscription and native view creation are separate renderer
    // effects. React may remount them in development, so an event-only bridge
    // can miss the one state change that assigns the WebContents. Replay the
    // current state after subscribing to make readiness deterministic.
    void bridge
      .getTabState(tabId)
      .then((state) => {
        if (!disposed && state) applyState(tabId, state);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      setNativePreviewFocused(tabId, false);
      unsubscribe();
    };
  }, [bridge, clearBrowserPointer, reportStatus, tabId, threadRef]);
}

function shouldClearBrowserPointer(
  previous: DesktopPreviewTabState["navStatus"] | null,
  current: DesktopPreviewTabState["navStatus"],
): boolean {
  if (!previous) return false;
  if (current.kind === "Loading" && previous.kind !== "Loading") return true;
  if (current.kind === "Idle" || previous.kind === "Idle") return false;
  return current.url !== previous.url;
}

/**
 * Decide whether a state change warrants an RPC to the server, and shape
 * the report payload.
 *
 * - Idle never reports — the tab is post-close or pre-load and the server
 *   already knows the canonical state from `open` / `closed`.
 * - We dedupe on (kind, url): consecutive Loading→Loading→Loading for the
 *   same URL collapses to a single RPC, ditto Success.
 * - LoadFailed always reports (the server uses it to emit `failed`).
 */
function buildReportInput(args: {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly state: DesktopPreviewTabState;
  readonly lastReportedUrl: string | null;
  readonly lastReportedKind: DesktopPreviewTabState["navStatus"]["kind"] | null;
}): {
  readonly input: PreviewReportStatusInput;
  readonly lastReportedUrl: string;
  readonly lastReportedKind: DesktopPreviewTabState["navStatus"]["kind"];
} | null {
  const { threadId, tabId, state, lastReportedUrl, lastReportedKind } = args;
  const status = state.navStatus;
  if (status.kind === "Idle") return null;

  // Skip if we've already reported the same kind+url. LoadFailed always
  // reports (rapid duplicate failures are unusual and worth surfacing).
  const sameAsLast =
    status.kind !== "LoadFailed" &&
    status.kind === lastReportedKind &&
    status.url === lastReportedUrl;
  if (sameAsLast) return null;

  const base = {
    threadId,
    tabId,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
  };
  if (status.kind === "LoadFailed") {
    return {
      input: {
        ...base,
        navStatus: {
          _tag: "LoadFailed",
          url: status.url,
          title: status.title,
          code: status.code,
          description: status.description,
        },
      },
      lastReportedUrl: status.url,
      lastReportedKind: "LoadFailed",
    };
  }
  return {
    input: {
      ...base,
      navStatus: { _tag: status.kind, url: status.url, title: status.title },
    },
    lastReportedUrl: status.url,
    lastReportedKind: status.kind,
  };
}
