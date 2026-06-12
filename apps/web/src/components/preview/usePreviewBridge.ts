"use client";

import type {
  DesktopPreviewTabState,
  PreviewReportStatusInput,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { type DesktopPreviewOverlay, usePreviewStateStore } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";

/**
 * Mirrors low-latency desktop state into the store and reflects navigation
 * events back to the server. Webview lifetime is owned by ElectronBrowserHost.
 */
export function usePreviewBridge(input: { threadRef: ScopedThreadRef; tabId: string }): void {
  const { threadRef, tabId } = input;
  const applyDesktopState = usePreviewStateStore((state) => state.applyDesktopState);
  const bridge = previewBridge;

  // One bridge subscription does both jobs (mirror state + forward to
  // server) so the desktop bridge keeps a single listener entry per tab.
  const lastReportedUrl = useRef<string | null>(null);
  const lastReportedKind = useRef<DesktopPreviewTabState["navStatus"]["kind"] | null>(null);
  useEffect(() => {
    if (!bridge || typeof window === "undefined") return;
    const api = ensureEnvironmentApi(threadRef.environmentId);
    lastReportedUrl.current = null;
    lastReportedKind.current = null;
    const unsubscribe = bridge.onStateChange((changedTabId, state) => {
      if (changedTabId !== tabId) return;
      applyDesktopState(threadRef, tabId, projectDesktopState(state));
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
      void api.preview.reportStatus(reported.input).catch(() => undefined);
    });
    return unsubscribe;
  }, [applyDesktopState, bridge, tabId, threadRef]);
}

function projectDesktopState(state: DesktopPreviewTabState): DesktopPreviewOverlay {
  return {
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.navStatus.kind === "Loading",
    zoomFactor: state.zoomFactor,
    controller: state.controller,
  };
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
