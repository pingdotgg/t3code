"use client";

import { scopedThreadKey } from "@t3tools/client-runtime";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { ensureEnvironmentApi } from "~/environmentApi";
import { normalizeElementContextSelection } from "~/lib/elementContext";
import {
  appendPreviewAnnotationPrompt,
  previewAnnotationScreenshotFile,
} from "~/lib/previewAnnotation";
import { ensureLocalApi } from "~/localApi";
import { selectThreadPreviewState, usePreviewStateStore } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { openPreviewSession } from "./openPreviewSession";
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
  const [pickActive, setPickActive] = useState(false);
  const pickActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const previewState = usePreviewStateStore((state) =>
    selectThreadPreviewState(state.byThreadKey, threadRef),
  );
  const applyServerSnapshot = usePreviewStateStore((state) => state.applyServerSnapshot);
  const rememberUrl = usePreviewStateStore((state) => state.rememberUrl);
  const addElementContext = useComposerDraftStore((store) => store.addElementContext);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
          await openPreviewSession({
            previewApi: api.preview,
            threadRef,
            url: next,
            applyServerSnapshot,
            rememberUrl,
          });
        }
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [applyServerSnapshot, rememberUrl, tabId, threadRef],
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

  const handlePickElement = useCallback(() => {
    if (!previewBridge || !tabId) return;
    if (pickActiveRef.current) {
      void previewBridge.cancelPickElement(tabId).catch(() => undefined);
      return;
    }
    // Snapshot whatever the user was focused on (typically the chat
    // composer textarea or the chrome-row pick button) BEFORE main steals
    // focus into the guest webContents. We restore it when the pick
    // resolves so the user's typing context isn't lost — otherwise after
    // every pick they'd have to click back into the textarea.
    const previouslyFocused =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    pickActiveRef.current = true;
    setPickActive(true);
    void (async () => {
      try {
        const annotation = await previewBridge.pickElement(tabId);
        if (!annotation) return;
        for (const target of annotation.elements) {
          const selection = normalizeElementContextSelection(target.element);
          if (selection) addElementContext(threadRef, selection);
        }
        const currentPrompt = getComposerDraft(threadRef)?.prompt ?? "";
        setPrompt(threadRef, appendPreviewAnnotationPrompt(currentPrompt, annotation));
        const screenshotFile = await previewAnnotationScreenshotFile(annotation);
        if (screenshotFile && annotation.screenshot) {
          addImage(threadRef, {
            type: "image",
            id: annotation.id,
            name: screenshotFile.name,
            mimeType: screenshotFile.type,
            sizeBytes: screenshotFile.size,
            previewUrl: annotation.screenshot.dataUrl,
            file: screenshotFile,
          });
        }
      } catch {
        // Picker failed (e.g. webview navigated). Treat as silent cancel.
      } finally {
        pickActiveRef.current = false;
        // Avoid `setState on unmounted component` if the panel/thread closed
        // while the pick was in flight.
        if (isMountedRef.current) setPickActive(false);
        // Best-effort: restore focus to whatever the user had before the
        // pick stole it into the guest webContents. Skip if the previously-
        // focused element was unmounted or is no longer focusable.
        if (
          previouslyFocused &&
          previouslyFocused.isConnected &&
          typeof previouslyFocused.focus === "function"
        ) {
          try {
            previouslyFocused.focus({ preventScroll: true });
          } catch {
            // Some elements throw on .focus() (detached iframes, etc.).
          }
        }
      }
    })();
  }, [addElementContext, addImage, getComposerDraft, setPrompt, tabId, threadRef]);

  // If the active tab changes mid-pick (close, thread switch, hot restart),
  // tell main to tear down the in-flight session AND reset our local toggle
  // state so the button doesn't get stuck pressed against a stale tab id.
  useEffect(() => {
    return () => {
      if (!pickActiveRef.current) return;
      pickActiveRef.current = false;
      if (previewBridge && tabId) {
        void previewBridge.cancelPickElement(tabId).catch(() => undefined);
      }
      if (isMountedRef.current) setPickActive(false);
    };
  }, [tabId]);

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
        onPickElement={previewBridge && tabId ? handlePickElement : undefined}
        pickActive={pickActive}
        // Disable when there's no tab (nothing to pick on) OR the page
        // failed to load (a React overlay covers the webview, so the
        // user wouldn't be able to actually click anything underneath).
        pickDisabled={!tabId || isUnreachable}
        pickDisabledReason={
          isUnreachable ? "Page didn't load — pick unavailable until the page renders" : undefined
        }
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
        {navStatus._tag === "LoadFailed" ? (
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
