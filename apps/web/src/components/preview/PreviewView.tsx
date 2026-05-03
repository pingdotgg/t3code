"use client";

import { scopedThreadKey } from "@t3tools/client-runtime";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { ensureLocalApi } from "~/localApi";
import { selectThreadPreviewState, usePreviewStateStore } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu } from "./PreviewMoreMenu";
import { PreviewUnreachable } from "./PreviewUnreachable";
import { PreviewWebview } from "./PreviewWebview";
import { useLoadingProgress } from "./useLoadingProgress";
import { usePreviewSession } from "./usePreviewSession";
import { ZoomIndicator } from "./ZoomIndicator";

interface Props {
  threadRef: ScopedThreadRef;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
}

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

/**
 * Single-tab preview surface: chrome row on top, one webview below, empty
 * state when no session exists for the thread.
 */
export function PreviewView({ threadRef, configuredUrls, visible }: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState(0);
  const previewState = usePreviewStateStore((state) =>
    selectThreadPreviewState(state.byThreadKey, threadRef),
  );
  const rememberUrl = usePreviewStateStore((state) => state.rememberUrl);

  usePreviewSession(threadRef);

  const { snapshot, desktopOverlay } = previewState;
  const tabId = snapshot?.tabId ?? null;
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const loading = desktopOverlay?.loading ?? navStatus._tag === "Loading";
  const canGoBack = desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  const loadProgress = useLoadingProgress(loading);

  const handleSubmitUrl = useCallback(
    async (next: string) => {
      const api = ensureEnvironmentApi(threadRef.environmentId);
      try {
        if (tabId && previewBridge) {
          // Drive the webview imperatively; `usePreviewBridge` mirrors the
          // resolved URL back to the server so other clients stay in sync.
          await previewBridge.navigate(tabId, next);
          rememberUrl(threadRef, next);
        } else {
          const resolved = await api.preview.open({ threadId: threadRef.threadId, url: next });
          const resolvedUrl = resolved.navStatus._tag === "Idle" ? next : resolved.navStatus.url;
          rememberUrl(threadRef, resolvedUrl);
        }
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [rememberUrl, tabId, threadRef],
  );

  const handleRefresh = useCallback(() => {
    if (previewBridge && tabId) void previewBridge.refresh(tabId);
  }, [tabId]);

  const handleZoomIn = useCallback(() => {
    if (previewBridge && tabId) void previewBridge.zoomIn(tabId);
  }, [tabId]);

  const handleZoomOut = useCallback(() => {
    if (previewBridge && tabId) void previewBridge.zoomOut(tabId);
  }, [tabId]);

  const handleResetZoom = useCallback(() => {
    if (previewBridge && tabId) void previewBridge.resetZoom(tabId);
  }, [tabId]);

  const handleBack = useCallback(() => {
    if (previewBridge && tabId) void previewBridge.goBack(tabId);
  }, [tabId]);

  const handleForward = useCallback(() => {
    if (previewBridge && tabId) void previewBridge.goForward(tabId);
  }, [tabId]);

  const handleOpenInBrowser = useCallback(() => {
    if (!localApi || !url) return;
    void localApi.shell.openExternal(url).catch(() => undefined);
  }, [url]);

  // Subscribe only while visible; `toggle-panel` is owned by ChatView's
  // URL-aware handler regardless of whether the panel is currently mounted.
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => {
      switch (action) {
        case "refresh":
          handleRefresh();
          return;
        case "focus-url":
          setFocusUrlNonce((value) => value + 1);
          return;
        case "zoom-in":
          handleZoomIn();
          return;
        case "zoom-out":
          handleZoomOut();
          return;
        case "reset-zoom":
          handleResetZoom();
          return;
        case "toggle-panel":
          return;
      }
    });
  }, [handleRefresh, handleResetZoom, handleZoomIn, handleZoomOut, visible]);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={url}
        loading={loading}
        loadProgress={loadProgress}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        refreshDisabled={refreshDisabled}
        focusUrlNonce={focusUrlNonce}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        trailingActions={
          previewBridge ? (
            <PreviewMoreMenu
              tabId={tabId}
              hasWebContents={desktopOverlay !== null}
              zoomFactor={desktopOverlay?.zoomFactor ?? 1}
            />
          ) : null
        }
      />

      <div className="relative flex-1 overflow-hidden">
        {tabId && snapshot ? (
          <PreviewWebview
            key={tabId}
            threadRef={threadRef}
            tabId={tabId}
            initialUrl={url || null}
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <PreviewEmptyState
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentlySeenUrls={previewState.recentlySeenUrls}
            onOpenUrl={(next) => void handleSubmitUrl(next)}
          />
        )}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        {isUnreachable && navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
