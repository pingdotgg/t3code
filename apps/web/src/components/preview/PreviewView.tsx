"use client";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { PictureInPicture2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";

import { useComposerDraftStore } from "~/composerDraftStore";
import { previewAnnotationScreenshotFile } from "~/lib/previewAnnotation";
import { readLocalApi } from "~/localApi";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useEnvironment, useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { openPreviewSession } from "./openPreviewSession";
import { openDiscoveredPort } from "./openDiscoveredPort";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { formatPreviewUrl } from "./previewUrlPresentation";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu } from "./PreviewMoreMenu";
import {
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "~/browser/browserViewportActions";
import { resolveResponsiveBrowserViewportSize } from "~/browser/browserViewportLayout";
import { PreviewUnreachable } from "./PreviewUnreachable";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { useLoadingProgress } from "./useLoadingProgress";
import { usePreviewSession } from "./usePreviewSession";
import { ZoomIndicator } from "./ZoomIndicator";
import { AgentBrowserCursor } from "./AgentBrowserCursor";
import {
  startBrowserRecording,
  stopBrowserRecording,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";

interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  /** When provided, renders a panel close affordance in the chrome row. */
  onClose?: (() => void) | undefined;
}

/**
 * Single-tab preview surface: chrome row on top, one webview below, empty
 * state when no session exists for the thread.
 */
export function PreviewView({
  threadRef,
  tabId: requestedTabId,
  configuredUrls,
  visible,
  onClose,
}: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState<number | undefined>(undefined);
  const [pickActive, setPickActive] = useState(false);
  const activeRecordingTabIds = useActiveBrowserRecordingTabIds();
  const pickActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const previewState = useThreadPreviewState(threadRef);
  const miniPlayerTabId = usePreviewMiniPlayerStore(
    (state) => state.byThreadKey[scopedThreadKey(threadRef)]?.tabId ?? null,
  );
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const environment = useEnvironment(threadRef.environmentId);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const open = useAtomCommand(previewEnvironment.open);
  const resize = useAtomCommand(previewEnvironment.resize, "preview viewport resize");

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const tabId = requestedTabId ?? previewState.activeTabId;
  // Desktop resources (webview, surface rects, recordings) are keyed by the
  // runtime id so a server restart cannot alias them onto reused tab ids.
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const loading = desktopOverlay?.loading ?? navStatus._tag === "Loading";
  const canGoBack = desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const controller = desktopOverlay?.controller ?? "none";
  const loadProgress = useLoadingProgress(loading);
  const displayUrl =
    url && environment && environmentHttpBaseUrl
      ? (formatPreviewUrl({
          url,
          environmentLabel: environment.label,
          environmentHttpBaseUrl,
        }) ?? undefined)
      : undefined;
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const panelRect = useBrowserSurfaceStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );

  const navigateToResolvedUrl = useCallback(
    async (resolvedUrl: string) => {
      if (runtimeTabId && previewBridge) {
        // Drive the webview imperatively; `usePreviewBridge` mirrors the
        // resolved URL back to the server so other clients stay in sync.
        await previewBridge.navigate(runtimeTabId, resolvedUrl);
        rememberPreviewUrl(threadRef, resolvedUrl);
      } else {
        await openPreviewSession({
          openPreview: open,
          threadRef,
          url: resolvedUrl,
        });
      }
    },
    [open, runtimeTabId, threadRef],
  );

  const handleSubmitUrl = useCallback(
    async (next: string) => {
      try {
        await navigateToResolvedUrl(normalizePreviewUrl(next));
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [navigateToResolvedUrl],
  );

  const handleOpenServerUrl = useCallback(
    async (next: string) => {
      try {
        await navigateToResolvedUrl(resolveDiscoveredServerUrl(threadRef.environmentId, next));
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [navigateToResolvedUrl, threadRef.environmentId],
  );

  const handleRefresh = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.refresh(runtimeTabId);
  }, [runtimeTabId]);

  const handleZoomIn = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.zoomIn(runtimeTabId);
  }, [runtimeTabId]);

  const handleZoomOut = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.zoomOut(runtimeTabId);
  }, [runtimeTabId]);

  const handleResetZoom = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.resetZoom(runtimeTabId);
  }, [runtimeTabId]);

  const handleViewportChange = useCallback(
    async (nextViewport: PreviewViewportSetting) => {
      if (!tabId) return;
      const result = await resize({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tabId,
          viewport: nextViewport,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to resize browser viewport",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        throw error;
      }
      updatePreviewServerSnapshot(threadRef, result.value);
    },
    [resize, tabId, threadRef],
  );

  const handleToggleDeviceToolbar = () => {
    if (!runtimeTabId) return;
    if (viewport._tag !== "fill") {
      void commitBrowserViewportChange(runtimeTabId, FILL_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }

    const responsiveSize = panelRect
      ? resolveResponsiveBrowserViewportSize(panelRect, desktopOverlay?.zoomFactor)
      : { width: 1024, height: 768 };
    void commitBrowserViewportChange(runtimeTabId, { _tag: "freeform", ...responsiveSize }).catch(
      () => undefined,
    );
  };

  useEffect(() => {
    if (!runtimeTabId) return;
    return subscribeBrowserViewportChange(runtimeTabId, handleViewportChange);
  }, [handleViewportChange, runtimeTabId]);

  const handleBack = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.goBack(runtimeTabId);
  }, [runtimeTabId]);

  const handleForward = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.goForward(runtimeTabId);
  }, [runtimeTabId]);

  const handleOpenInBrowser = useCallback(() => {
    if (!url) return;
    const localApi = readLocalApi();
    if (!localApi) return;
    void localApi.shell.openExternal(url).catch(() => undefined);
  }, [url]);

  const handleCapture = useCallback(
    (record: boolean) => {
      if (!previewBridge || !runtimeTabId || !tabId) return;
      const bridge = previewBridge;
      const recordingThisTab = activeRecordingTabIds.has(runtimeTabId);
      if (recordingThisTab) {
        void stopBrowserRecording(runtimeTabId).then(
          (artifact) => {
            if (!artifact) return;
            let pathCopied = false;
            let toastId: ReturnType<typeof toastManager.add>;
            const revealAction = {
              children: revealInFileExplorerLabel(navigator.platform),
              onClick: () => void bridge.revealArtifact(artifact.path),
            };
            const updateRecordingToast = (
              type: "success" | "error" = "success",
              title = "Recording saved",
              description?: string,
            ) => {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type,
                  title,
                  description,
                  actionProps: revealAction,
                  data: {
                    secondaryActionProps: {
                      children: pathCopied ? "Copied!" : "Copy path",
                      disabled: pathCopied,
                      onClick: copyPath,
                    },
                    secondaryActionVariant: "outline",
                  },
                }),
              );
            };
            const copyPath = () => {
              if (!navigator.clipboard?.writeText) {
                updateRecordingToast(
                  "error",
                  "Unable to copy recording path",
                  "Clipboard API unavailable.",
                );
                return;
              }
              void navigator.clipboard.writeText(artifact.path).then(
                () => {
                  pathCopied = true;
                  updateRecordingToast();
                  window.setTimeout(() => {
                    pathCopied = false;
                    updateRecordingToast();
                  }, 2_000);
                },
                (error) => {
                  updateRecordingToast(
                    "error",
                    "Unable to copy recording path",
                    error instanceof Error ? error.message : "An error occurred.",
                  );
                },
              );
            };
            toastId = toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Recording saved",
                actionProps: revealAction,
                data: {
                  secondaryActionProps: {
                    children: "Copy path",
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          },
          (error) => {
            toastManager.add({
              type: "error",
              title: "Unable to stop recording",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          },
        );
        return;
      }
      if (record) {
        void startBrowserRecording(runtimeTabId, threadRef, tabId).catch((error) => {
          toastManager.add({
            type: "error",
            title: "Unable to start recording",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        });
        return;
      }
      void bridge.captureScreenshot(runtimeTabId).then(
        (artifact) => {
          const revealAction = {
            children: revealInFileExplorerLabel(navigator.platform),
            onClick: () => void bridge.revealArtifact(artifact.path),
          };
          let pathCopied = false;
          let imageCopied = false;
          let toastId: ReturnType<typeof toastManager.add>;

          const updateScreenshotToast = (
            type: "success" | "error" = "success",
            title = "Screenshot saved",
            description?: string,
          ) => {
            toastManager.update(
              toastId,
              stackedThreadToast({
                type,
                title,
                description,
                actionProps: {
                  children: imageCopied ? "Copied!" : "Copy image",
                  disabled: imageCopied,
                  onClick: copyImage,
                },
                data: {
                  additionalActions: [
                    {
                      id: "copy-path",
                      props: {
                        children: pathCopied ? "Copied!" : "Copy path",
                        disabled: pathCopied,
                        onClick: copyPath,
                      },
                    },
                  ],
                  secondaryActionProps: revealAction,
                  secondaryActionVariant: "outline",
                },
              }),
            );
          };
          const copyPath = () => {
            if (!navigator.clipboard?.writeText) {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot path",
                "Clipboard API unavailable.",
              );
              return;
            }
            void navigator.clipboard.writeText(artifact.path).then(
              () => {
                pathCopied = true;
                updateScreenshotToast();
                window.setTimeout(() => {
                  pathCopied = false;
                  updateScreenshotToast();
                }, 2_000);
              },
              (error) => {
                updateScreenshotToast(
                  "error",
                  "Unable to copy screenshot path",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              },
            );
          };

          const copyImage = () => {
            void bridge.copyArtifactToClipboard(artifact.path).then(
              () => {
                imageCopied = true;
                updateScreenshotToast();
                window.setTimeout(() => {
                  imageCopied = false;
                  updateScreenshotToast();
                }, 2_000);
              },
              (error) => {
                updateScreenshotToast(
                  "error",
                  "Unable to copy screenshot",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              },
            );
          };

          toastId = toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Screenshot saved",
              actionProps: {
                children: "Copy image",
                onClick: copyImage,
              },
              data: {
                additionalActions: [
                  {
                    id: "copy-path",
                    props: {
                      children: "Copy path",
                      onClick: copyPath,
                    },
                  },
                ],
                secondaryActionProps: revealAction,
                secondaryActionVariant: "outline",
              },
            }),
          );
        },
        (error) => {
          toastManager.add({
            type: "error",
            title: "Unable to capture screenshot",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
    },
    [activeRecordingTabIds, runtimeTabId, tabId, threadRef],
  );

  const handlePickElement = useCallback(() => {
    if (!previewBridge || !runtimeTabId) return;
    if (pickActiveRef.current) {
      void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
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
        const annotation = await previewBridge.pickElement(runtimeTabId);
        if (!annotation) return;
        addPreviewAnnotation(threadRef, annotation);
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
  }, [addImage, addPreviewAnnotation, runtimeTabId, threadRef]);

  // If the active tab changes mid-pick (close, thread switch, hot restart),
  // tell main to tear down the in-flight session AND reset our local toggle
  // state so the button doesn't get stuck pressed against a stale tab id.
  useEffect(() => {
    return () => {
      if (!pickActiveRef.current) return;
      pickActiveRef.current = false;
      if (previewBridge && runtimeTabId) {
        void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      }
      if (isMountedRef.current) setPickActive(false);
    };
  }, [runtimeTabId]);

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
          setFocusUrlNonce((value) => (value ?? 0) + 1);
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
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={url}
        displayUrl={displayUrl}
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
        onCapture={previewBridge && tabId ? handleCapture : undefined}
        captureDisabled={!desktopOverlay || isUnreachable}
        recording={runtimeTabId !== null && activeRecordingTabIds.has(runtimeTabId)}
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
          <>
            {tabId ? (
              <Button
                variant={miniPlayerTabId === tabId ? "secondary" : "ghost"}
                size="icon-xs"
                type="button"
                aria-label={
                  miniPlayerTabId === tabId ? "Close floating preview" : "Open floating preview"
                }
                disabled={!desktopOverlay || isUnreachable}
                onClick={() => {
                  if (miniPlayerTabId === tabId) {
                    usePreviewMiniPlayerStore.getState().close(threadRef);
                  } else {
                    usePreviewMiniPlayerStore.getState().open(threadRef, tabId);
                  }
                }}
              >
                <PictureInPicture2 />
              </Button>
            ) : null}
            {previewBridge ? (
              <PreviewMoreMenu
                tabId={runtimeTabId}
                hasWebContents={desktopOverlay !== null}
                zoomFactor={desktopOverlay?.zoomFactor ?? 1}
                colorScheme={desktopOverlay?.colorScheme ?? "system"}
                deviceToolbarVisible={viewport._tag !== "fill"}
                onToggleDeviceToolbar={handleToggleDeviceToolbar}
              />
            ) : null}
            {onClose ? (
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label="Close browser panel"
                onClick={onClose}
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </>
        }
      />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && !showEmptyState ? (
          <BrowserSurfaceSlot
            key={runtimeTabId}
            tabId={runtimeTabId}
            visible={visible && miniPlayerTabId !== tabId && !isUnreachable}
            className="absolute inset-0 h-full w-full"
          />
        ) : null}
        {showEmptyState ? (
          <PreviewEmptyState
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentlySeenUrls={previewState.recentlySeenUrls}
            onOpenUrl={(url) => void handleOpenServerUrl(url)}
            onOpenServer={(server) =>
              tabId
                ? void handleOpenServerUrl(server.url)
                : void openDiscoveredPort({
                    threadRef,
                    port: server,
                    openPreview: open,
                  })
            }
          />
        ) : null}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        {runtimeTabId && desktopOverlay && !showEmptyState && !isUnreachable ? (
          <AgentBrowserCursor
            tabId={runtimeTabId}
            zoomFactor={desktopOverlay.zoomFactor}
            controller={controller}
          />
        ) : null}
        {controller !== "none" ? (
          <div className="pointer-events-none absolute left-3 top-3 z-40 rounded-full border border-border/70 bg-background/90 px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur">
            {controller === "agent" ? "Agent controlling browser" : "Human control"}
          </div>
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
