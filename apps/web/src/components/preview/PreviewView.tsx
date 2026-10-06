"use client";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type PreviewAnnotationPayload,
  type PreviewViewportSetting,
  type ScopedThreadRef,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  removeUrlForThread,
  setTitleForThreadUrl,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { type ComposerImageAttachment, useComposerDraftStore } from "~/composerDraftStore";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import { ensureLocalApi } from "~/localApi";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { openPreviewSession } from "./openPreviewSession";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu, type PreviewMoreMenuActions } from "./PreviewMoreMenu";
import {
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "~/browser/browserViewportActions";
import { browserResponsiveViewportForToggle, useBrowserDefaults } from "~/browser/browserDefaults";
import { BrowserDeviceToolbar } from "~/browser/BrowserDeviceToolbar";
import { BROWSER_DEVICE_TOOLBAR_HEIGHT } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";
import { PreviewUnreachable } from "./PreviewUnreachable";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { Badge } from "~/components/ui/badge";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useRendersServerTabNatively } from "~/browser/previewRuntime";
import { ServerBrowserSurface, type ServerBrowserHandle } from "~/browser/ServerBrowserSurface";
import { cn } from "~/lib/utils";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { usePreviewSession } from "./usePreviewSession";
import { ZoomIndicator } from "./ZoomIndicator";
import { AgentBrowserCursor } from "./AgentBrowserCursor";
import {
  findActiveBrowserRecordingRuntimeTabId,
  isBrowserRecordingStartCancelledError,
  startBrowserRecording,
  stopBrowserRecording,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

function previewProfileName(
  profiles: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  profileId: string,
): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? "Removed profile";
}

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

/**
 * Single-tab preview surface: chrome row on top, one webview below, empty
 * state when no session exists for the thread.
 */
export function PreviewView({
  threadRef,
  tabId: requestedTabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState<number | undefined>(undefined);
  const [pickActive, setPickActive] = useState(false);
  const activeRecordingTabIds = useActiveBrowserRecordingTabIds();
  const pickActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  // Kept in sync so the title effect can depend on the stable thread key
  // instead of the thread object, which is recreated on every update.
  const threadRefRef = useRef(threadRef);
  threadRefRef.current = threadRef;
  const previewState = useThreadPreviewState(threadRef);
  const recentHistoryEntries = useThreadRecentHistory(
    threadRef,
    BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  );
  const miniPlayerTabId = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayerTabId(state.byThreadKey, threadRef),
  );
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const environmentHostname = environmentHttpBaseUrl
    ? new URL(environmentHttpBaseUrl).hostname
    : null;
  const open = useAtomCommand(previewEnvironment.open);
  const resize = useAtomCommand(previewEnvironment.resize, "preview viewport resize");
  const adjust = useAtomCommand(previewEnvironment.adjust, "preview appearance or zoom");

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const tabId = requestedTabId ?? previewState.activeTabId;
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const recordingRuntimeTabId =
    tabId && runtimeTabId
      ? activeRecordingTabIds.has(runtimeTabId)
        ? runtimeTabId
        : findActiveBrowserRecordingRuntimeTabId(threadRef, tabId)
      : null;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  // Server tabs run in the environment's browser and stream to any client, except the
  // desktop app's own server's tabs, which render here natively while the server drives them.
  const nativeServerTab = useRendersServerTabNatively(threadRef.environmentId, snapshot);
  const isServerTab = snapshot?.runtime === "server" && !nativeServerTab;
  /** The server owns this tab's appearance, zoom, and size, whoever renders it. */
  const serverOwnsRendering = snapshot?.runtime === "server";
  const serverSurfaceRef = useRef<ServerBrowserHandle | null>(null);
  const [serverAspectRatioLocked, setServerAspectRatioLocked] = useState(false);
  const serverBodyRef = useRef<HTMLDivElement | null>(null);
  const [serverToolbarWidth, setServerToolbarWidth] = useState(0);
  // The streamed tab's device toolbar spans the panel; only measured while it shows.
  const serverToolbarShown =
    snapshot?.runtime === "server" && (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT)._tag !== "fill";
  useEffect(() => {
    const element = serverBodyRef.current;
    if (!element || !serverToolbarShown) return;
    const observer = new ResizeObserver(([entry]) =>
      setServerToolbarWidth(Math.max(1, Math.round(entry?.contentRect.width ?? 0))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [serverToolbarShown]);
  const [serverControlledTabId, setServerControlledTabId] = useState<string | null>(null);
  const serverInputDisabled = isServerTab && serverControlledTabId !== runtimeTabId;
  const [serverFrameTabId, setServerFrameTabId] = useState<string | null>(null);
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const loading = desktopOverlay?.loading ?? navStatus._tag === "Loading";
  const canGoBack = desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const serverStreamPending =
    isServerTab && !showEmptyState && !isUnreachable && serverFrameTabId !== runtimeTabId;
  const controller = desktopOverlay?.controller ?? "none";
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const browserDefaults = useBrowserDefaults();
  // A tab created before profiles existed carries no profile of its own. It
  // runs in the built-in `default` partition — the scope the browser used
  // before profiles — not in whatever profile is configured as the default
  // now, so that is what its label names and its clear actions target.
  // Passing the snapshot's raw `undefined` through would reach the IPC layer
  // as "every profile".
  const activeProfileId = snapshot?.profileId ?? DEFAULT_BROWSER_PROFILE_ID;
  const activeProfileName = previewProfileName(browserDefaults.profiles, activeProfileId);
  const panelRect = useBrowserSurfaceStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );

  const navUrl = navStatus._tag === "Success" ? navStatus.url : null;
  const navTitle = navStatus._tag === "Success" ? navStatus.title : null;
  const latestHistoryUrl = recentHistoryEntries[0]?.url;
  const threadKey = scopedThreadKey(threadRef);
  useEffect(() => {
    if (!navUrl || !navTitle || !latestHistoryUrl) return;
    // Agent-driven pages only enrich an existing requested URL.
    setTitleForThreadUrl(threadRefRef.current, navUrl, navTitle, environmentHostname);
    // threadKey stands in for threadRef, whose identity churns on every thread update.
  }, [environmentHostname, latestHistoryUrl, navTitle, navUrl, threadKey]);

  const navigateToResolvedUrl = useCallback(
    async (resolvedUrl: string) => {
      if (isServerTab && serverSurfaceRef.current) {
        if (serverInputDisabled) return false;
        serverSurfaceRef.current.navigate(resolvedUrl);
        rememberPreviewUrl(threadRef, resolvedUrl);
        return true;
      }
      if (runtimeTabId && previewBridge) {
        // The bridge mirrors the resolved URL back to the server.
        await previewBridge.navigate(runtimeTabId, resolvedUrl);
        rememberPreviewUrl(threadRef, resolvedUrl);
        return true;
      }
      const result = await openPreviewSession({ openPreview: open, threadRef, url: resolvedUrl });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add({
            type: "error",
            title: "Unable to open browser",
            description: error.message,
          });
        }
      }
      return result._tag === "Success";
    },
    [isServerTab, open, runtimeTabId, serverInputDisabled, threadRef],
  );

  const handleSubmitUrl = useCallback(
    async (next: string) => {
      try {
        const normalized = normalizePreviewUrl(next);
        if (await navigateToResolvedUrl(normalized)) {
          recordVisitForThread(threadRef, normalized);
        }
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [navigateToResolvedUrl, threadRef],
  );

  const handleOpenServerUrl = useCallback(
    async (next: string) => {
      try {
        // A server tab's browser runs on the environment, where loopback is already right.
        const resolved =
          isServerTab || !previewBridge
            ? normalizePreviewUrl(next)
            : resolveDiscoveredServerUrl(threadRef.environmentId, next);
        if (await navigateToResolvedUrl(resolved)) {
          recordVisitForThread(threadRef, next);
        }
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [isServerTab, navigateToResolvedUrl, threadRef],
  );

  const handleRefresh = useCallback(() => {
    if (isServerTab) serverSurfaceRef.current?.reload();
    else if (previewBridge && runtimeTabId) void previewBridge.refresh(runtimeTabId);
  }, [isServerTab, runtimeTabId]);

  /** Appearance and zoom of a server tab, through the server for every client. */
  const adjustServerTab = useCallback(
    async (change: Omit<PreviewAdjustInput, "threadId" | "tabId">) => {
      if (!tabId) return;
      const result = await adjust({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId, ...change },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to change the browser tab",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }
      updatePreviewServerSnapshot(threadRef, result.value);
    },
    [adjust, tabId, threadRef],
  );

  const serverZoomFactor = snapshot?.zoomFactor ?? DEFAULT_PREVIEW_ZOOM_FACTOR;
  const stepServerZoom = useCallback(
    (direction: -1 | 0 | 1) => {
      const index = PREVIEW_ZOOM_LEVELS.indexOf(serverZoomFactor);
      const next =
        direction === 0
          ? DEFAULT_PREVIEW_ZOOM_FACTOR
          : PREVIEW_ZOOM_LEVELS[
              Math.min(
                Math.max((index < 0 ? 7 : index) + direction, 0),
                PREVIEW_ZOOM_LEVELS.length - 1,
              )
            ]!;
      if (next !== serverZoomFactor) void adjustServerTab({ zoomFactor: next });
    },
    [adjustServerTab, serverZoomFactor],
  );

  const handleZoomIn = useCallback(() => {
    if (serverOwnsRendering) stepServerZoom(1);
    else if (previewBridge && runtimeTabId) void previewBridge.zoomIn(runtimeTabId);
  }, [runtimeTabId, serverOwnsRendering, stepServerZoom]);

  const handleZoomOut = useCallback(() => {
    if (serverOwnsRendering) stepServerZoom(-1);
    else if (previewBridge && runtimeTabId) void previewBridge.zoomOut(runtimeTabId);
  }, [runtimeTabId, serverOwnsRendering, stepServerZoom]);

  const handleResetZoom = useCallback(() => {
    if (serverOwnsRendering) stepServerZoom(0);
    else if (previewBridge && runtimeTabId) void previewBridge.resetZoom(runtimeTabId);
  }, [runtimeTabId, serverOwnsRendering, stepServerZoom]);

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

    void commitBrowserViewportChange(
      runtimeTabId,
      browserResponsiveViewportForToggle({
        defaults: browserDefaults,
        panelRect,
        zoomFactor: serverOwnsRendering ? serverZoomFactor : desktopOverlay?.zoomFactor,
      }),
    ).catch(() => undefined);
  };

  useEffect(() => {
    if (!runtimeTabId) return;
    return subscribeBrowserViewportChange(runtimeTabId, handleViewportChange);
  }, [handleViewportChange, runtimeTabId]);

  const handleBack = useCallback(() => {
    if (isServerTab) serverSurfaceRef.current?.history(-1);
    else if (previewBridge && runtimeTabId) void previewBridge.goBack(runtimeTabId);
  }, [isServerTab, runtimeTabId]);

  const handleForward = useCallback(() => {
    if (isServerTab) serverSurfaceRef.current?.history(1);
    else if (previewBridge && runtimeTabId) void previewBridge.goForward(runtimeTabId);
  }, [isServerTab, runtimeTabId]);

  const handleOpenInBrowser = useCallback(() => {
    if (!localApi || !url) return;
    void localApi.shell.openExternal(url).catch(() => undefined);
  }, [url]);

  const handlePictureInPicture = useCallback(() => {
    if (!tabId) return;
    if (miniPlayerTabId === tabId) {
      usePreviewMiniPlayerStore.getState().close(threadRef);
      return;
    }
    usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(tabId));
    useRightPanelStore.getState().close(threadRef);
  }, [miniPlayerTabId, tabId, threadRef]);

  /**
   * The menu's actions. A server tab, streamed or rendered natively here, runs
   * them through its environment, so every client and agent sees one state.
   * Opening DevTools and a separate window need the desktop's own page.
   */
  const desktopCall = (op: ((tabId: string) => Promise<void>) | undefined) => () => {
    if (op && runtimeTabId) void op(runtimeTabId).catch(() => undefined);
  };
  const moreMenuActions: PreviewMoreMenuActions | null = serverOwnsRendering
    ? {
        hardReload: () => void adjustServerTab({ hardReload: true }),
        setColorScheme: (colorScheme) => void adjustServerTab({ colorScheme }),
        zoomIn: handleZoomIn,
        zoomOut: handleZoomOut,
        resetZoom: handleResetZoom,
        clearCookies: () => void adjustServerTab({ clear: "cookies" }),
        clearCache: () => void adjustServerTab({ clear: "cache" }),
        ...(nativeServerTab && previewBridge
          ? {
              openDevTools: desktopCall(previewBridge.openDevTools),
              toggleNativePictureInPicture: () => handleNativePictureInPicture(),
            }
          : {}),
      }
    : previewBridge
      ? {
          hardReload: desktopCall(previewBridge.hardReload),
          setColorScheme: (colorScheme) => {
            if (runtimeTabId)
              void previewBridge?.setColorScheme(runtimeTabId, colorScheme).catch(() => undefined);
          },
          zoomIn: handleZoomIn,
          zoomOut: handleZoomOut,
          resetZoom: handleResetZoom,
          clearCookies: () =>
            void previewBridge
              ?.clearCookies(threadRef.environmentId, activeProfileId)
              .catch(() => undefined),
          clearCache: () =>
            void previewBridge
              ?.clearCache(threadRef.environmentId, activeProfileId)
              .catch(() => undefined),
          openDevTools: desktopCall(previewBridge.openDevTools),
          toggleNativePictureInPicture: () => handleNativePictureInPicture(),
        }
      : null;

  const handleNativePictureInPicture = useCallback(() => {
    if (!previewBridge || !runtimeTabId) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [desktopOverlay?.pictureInPicture, runtimeTabId]);

  const handleCapture = useCallback(
    (record: boolean) => {
      if (!previewBridge || !runtimeTabId || !tabId) return;
      const bridge = previewBridge;
      if (recordingRuntimeTabId) {
        void stopBrowserRecording(recordingRuntimeTabId).then(
          (artifact) => {
            if (!artifact) return;
            let pathCopied = false;
            let toastId: ReturnType<typeof toastManager.add>;

            const copyPath = () => {
              if (!navigator.clipboard?.writeText) {
                toastManager.update(
                  toastId,
                  stackedThreadToast({
                    type: "error",
                    title: "Unable to copy recording path",
                    description: "Clipboard API unavailable.",
                    actionProps: revealAction,
                  }),
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
                  toastManager.update(
                    toastId,
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to copy recording path",
                      description: error instanceof Error ? error.message : "An error occurred.",
                      actionProps: revealAction,
                    }),
                  );
                },
              );
            };

            const revealAction = {
              children: revealInFileExplorerLabel(navigator.platform),
              onClick: () => void bridge.revealArtifact(artifact.path),
            };
            const updateRecordingToast = () => {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "success",
                  title: "Recording saved",
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
          const description = error instanceof Error ? error.message : "An error occurred.";
          if (isBrowserRecordingStartCancelledError(error)) return;
          toastManager.add({
            type: "error",
            title: "Unable to start recording",
            description,
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
                  secondaryActionProps: {
                    ...revealAction,
                  },
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
                secondaryActionProps: {
                  ...revealAction,
                },
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
    [recordingRuntimeTabId, runtimeTabId, tabId, threadRef],
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
        const result = await previewBridge.pickElement(runtimeTabId);
        if (!result) return;
        const { annotation: picked, submission, screenshotFailed = false } = result;
        // The structured annotation is still sendable when its optional crop
        // stalls or fails, so tell the user what they lost and keep going
        // instead of holding the composer for an attachment that never lands.
        // The stored copy drops the screenshot on failure, otherwise the prompt
        // would tell the agent a crop is attached when none was sent.
        const capture = capturePreviewAnnotationScreenshot(picked);
        // Main reports a crop that failed or timed out on its side; the local
        // conversion can fail too. Either way the user should hear about it.
        const cropDropped = screenshotFailed || capture.status === "failed";
        const annotation = capture.status === "failed" ? { ...picked, screenshot: null } : picked;
        addPreviewAnnotation(threadRef, annotation);
        if (cropDropped) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not capture the picked element",
              // The send path reports its own outcome, so only say what this
              // handler knows: the crop was dropped.
              description: "The annotation was kept without the screenshot.",
            }),
          );
        }
        const screenshotFile = capture.status === "captured" ? capture.file : null;
        const image =
          screenshotFile && annotation.screenshot
            ? ({
                type: "image",
                id: annotation.id,
                name: screenshotFile.name,
                mimeType: screenshotFile.type,
                sizeBytes: screenshotFile.size,
                previewUrl: annotation.screenshot.dataUrl,
                file: screenshotFile,
              } satisfies ComposerImageAttachment)
            : null;
        if (image) {
          addImage(threadRef, image);
        }
        if (submission === "send") {
          onSendAnnotation?.(annotation, image);
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
  }, [addImage, addPreviewAnnotation, onSendAnnotation, runtimeTabId, threadRef]);

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
        loading={loading || serverStreamPending}
        canGoBack={canGoBack && !serverInputDisabled}
        canGoForward={canGoForward && !serverInputDisabled}
        refreshDisabled={refreshDisabled || serverInputDisabled}
        inputDisabled={serverInputDisabled}
        focusUrlNonce={focusUrlNonce}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        // Capture, annotation, and the more menu drive the desktop webview, so
        // server tabs leave them out. Floating works for both.
        onCapture={previewBridge && tabId && !isServerTab ? handleCapture : undefined}
        captureDisabled={!desktopOverlay || isUnreachable}
        recording={recordingRuntimeTabId !== null}
        onPictureInPicture={
          tabId && (isServerTab || previewBridge) ? handlePictureInPicture : undefined
        }
        pictureInPicture={miniPlayerTabId === tabId}
        pictureInPictureDisabled={
          isUnreachable || (!isServerTab && !desktopOverlay?.hasWebContents)
        }
        onPickElement={previewBridge && tabId && !isServerTab ? handlePickElement : undefined}
        pickActive={pickActive}
        // Disable when there's no tab (nothing to pick on) OR the page
        // failed to load (a React overlay covers the webview, so the
        // user wouldn't be able to actually click anything underneath).
        pickDisabled={!tabId || isUnreachable}
        pickDisabledReason={
          isUnreachable ? "Page didn't load — pick unavailable until the page renders" : undefined
        }
        leadingActions={
          // Only when it differs from the default: labelling every tab
          // "Default" would be noise on the common case, while a tab in
          // another profile is exactly what needs calling out.
          activeProfileId !== browserDefaults.profileId ? (
            // Capped: profile names run to 48 characters, and an unbounded
            // badge in this row takes its width from the URL input, the only
            // flexible element in the compact chrome. The cap sits on the
            // badge and the truncation on an inner span, because `Badge` is an
            // `inline-flex` with `whitespace-nowrap` — `text-overflow` never
            // reaches a bare text node inside it, so the name would be cut off
            // at both ends with no ellipsis.
            <Tooltip>
              <TooltipTrigger render={<Badge variant="outline" className="max-w-28 shrink-0" />}>
                <span className="truncate">{activeProfileName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">{activeProfileName}</TooltipPopup>
            </Tooltip>
          ) : null
        }
        trailingActions={
          moreMenuActions ? (
            <PreviewMoreMenu
              enabled={
                runtimeTabId !== null &&
                (serverOwnsRendering || (desktopOverlay?.hasWebContents ?? false))
              }
              actions={moreMenuActions}
              profileName={activeProfileName}
              zoomFactor={
                serverOwnsRendering ? serverZoomFactor : (desktopOverlay?.zoomFactor ?? 1)
              }
              colorScheme={
                serverOwnsRendering
                  ? (snapshot?.colorScheme ?? "system")
                  : (desktopOverlay?.colorScheme ?? "system")
              }
              deviceToolbarVisible={viewport._tag !== "fill"}
              onToggleDeviceToolbar={handleToggleDeviceToolbar}
              nativePictureInPicture={desktopOverlay?.pictureInPicture ?? false}
            />
          ) : null
        }
      />

      <div ref={serverBodyRef} className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && isServerTab ? (
          <>
            {viewport._tag !== "fill" && !showEmptyState && !isUnreachable ? (
              <div className="absolute inset-x-0 top-0 z-10">
                <BrowserDeviceToolbar
                  setting={viewport}
                  width={serverToolbarWidth}
                  aspectRatio={serverAspectRatioLocked ? viewport.width / viewport.height : null}
                  onAspectRatioChange={(ratio) => setServerAspectRatioLocked(ratio !== null)}
                  onChange={(setting) => commitBrowserViewportChange(runtimeTabId, setting)}
                />
              </div>
            ) : null}
            <div
              className="absolute inset-x-0 bottom-0"
              style={{ top: viewport._tag !== "fill" ? BROWSER_DEVICE_TOOLBAR_HEIGHT : 0 }}
            >
              <ServerBrowserSurface
                key={runtimeTabId}
                ref={serverSurfaceRef}
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
                tabId={snapshot.tabId}
                visible={visible}
                onFirstFrame={() => setServerFrameTabId(runtimeTabId)}
                onControl={(control) =>
                  setServerControlledTabId(control?.controller === "you" ? runtimeTabId : null)
                }
                // Stays connected under the empty state so a URL picked there reaches the page.
                className={cn(
                  "absolute inset-0 h-full w-full",
                  (showEmptyState || isUnreachable) && "invisible",
                )}
              />
            </div>
          </>
        ) : runtimeTabId && snapshot && !showEmptyState ? (
          previewBridge ? (
            <BrowserSurfaceSlot
              key={runtimeTabId}
              tabId={runtimeTabId}
              visible={visible && !isUnreachable}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">
                This tab is open in the T3 Code desktop app.
              </p>
            </div>
          )
        ) : null}
        {showEmptyState ? (
          <PreviewEmptyState
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentEntries={recentHistoryEntries}
            onRemoveRecent={(url) => removeUrlForThread(threadRef, url)}
            onOpenUrl={(next) => void handleOpenServerUrl(next)}
          />
        ) : null}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        {runtimeTabId &&
        desktopOverlay &&
        !showEmptyState &&
        !isUnreachable &&
        !activeRecordingTabIds.has(runtimeTabId) ? (
          <AgentBrowserCursor
            tabId={runtimeTabId}
            zoomFactor={desktopOverlay.zoomFactor}
            controller={controller}
          />
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
