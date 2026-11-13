import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { previewStreamDownloadUrl } from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
} from "@t3tools/contracts";
import {
  normalizePreviewUrl,
  isPreviewUrlNormalizationError,
  resolveAddressBarInput,
  previewPdfAssetUrl,
  resolveSearchUrlTemplate,
} from "@t3tools/shared/preview";
import { Dispatch, RefObject, SetStateAction, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  removeUrlForThread,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { type ComposerImageAttachment, useComposerDraftStore } from "~/composerDraftStore";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import { ensureLocalApi } from "~/localApi";
import { getClientSettings } from "~/hooks/useSettings";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useEnvironmentSupportsServerBrowser } from "~/state/entities";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { usePreviewStreamAccess } from "~/state/previewStream";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { closePreviewSession } from "./closePreviewSession";
import { openPreviewSession } from "./openPreviewSession";
import { showPreviewPopup } from "./showPreviewPopup";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu, type PreviewMoreMenuActions } from "./PreviewMoreMenu";
import { commitBrowserViewportChange } from "~/browser/browserViewportActions";
import { browserResponsiveViewportForToggle, useBrowserDefaults } from "~/browser/browserDefaults";
import { BrowserDeviceToolbar } from "~/browser/BrowserDeviceToolbar";
import { BROWSER_DEVICE_TOOLBAR_HEIGHT } from "~/browser/browserViewportLayout";
import { useBrowserLayoutZoomFactor } from "~/browser/useBrowserLayoutZoomFactor";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";
import { PreviewFileNotShown, PreviewUnreachable } from "./PreviewUnreachable";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { Badge } from "~/components/ui/badge";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { alternatePreviewRuntime, useRendersServerTabNatively } from "~/browser/previewRuntime";
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
import { observeResize } from "~/lib/observeResize";
import type { BrowserDefaults } from "../../browser/browserDefaults.ts";
import type { CxOptions } from "class-variance-authority";
import type { BrowserImportResult, BrowserImportSource, BrowserImportSourceId, DesktopPreviewAnnotationTheme, DesktopPreviewColorScheme, DesktopPreviewOpenLinkEvent, DesktopPreviewPointerEvent, DesktopPreviewRecordingArtifact, DesktopPreviewRecordingInputEvent, DesktopPreviewScreenshotArtifact, DesktopPreviewTabDefaults, DesktopPreviewTabState, DesktopPreviewWebviewConfig, EnvironmentId, PreviewAnnotationSubmissionResult, PreviewForwardedShortcut, PreviewViewportSetting, ThreadId } from "@t3tools/contracts";
import type { BrowserViewportTarget } from "../../browser/browserViewportActions.ts";
import type { DesktopPreviewOverlay } from "../../previewStateStore.ts";
import type { BrowserHistoryEntry } from "../../browserHistoryStore.ts";
import type { Brand } from "effect/Brand";

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

function ServerTabFileNotShown(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly url: string;
  readonly download: { readonly id: string; readonly fileName: string };
}) {
  const access = usePreviewStreamAccess(props.threadRef.environmentId);
  return (
    <PreviewFileNotShown
      url={props.url}
      fileName={props.download.fileName}
      downloadUrl={
        access
          ? previewStreamDownloadUrl(
              { access, threadId: props.threadRef.threadId, tabId: props.tabId },
              props.download.id,
            )
          : null
      }
      onOpen={() => void localApi?.shell.openExternal(props.url).catch(() => undefined)}
    />
  );
}

export interface PreviewViewSurfaceProps {
  readonly activeProfileId: string;
  readonly activeProfileName: string;
  readonly activeRecordingTabIds: ReadonlySet<string>;
  readonly BROWSER_DEVICE_TOOLBAR_HEIGHT: 38;
  readonly browserDefaults: BrowserDefaults;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly cn: (...inputs: CxOptions) => string;
  readonly commitBrowserViewportChange: (target: BrowserViewportTarget, setting: PreviewViewportSetting) => Promise<void>;
  readonly configuredUrls: readonly string[] | undefined;
  readonly controller: "human" | "agent" | "none";
  readonly desktopOverlay: DesktopPreviewOverlay | null;
  readonly environmentHttpBaseUrl: string | null;
  readonly handleBack: () => void;
  readonly handleCapture: (record: boolean) => void;
  readonly handleForward: () => void;
  readonly handleMoveTab: () => Promise<void>;
  readonly handleOpenInBrowser: () => void;
  readonly handleOpenServerUrl: (next: string) => Promise<void>;
  readonly handlePickElement: () => void;
  readonly handlePictureInPicture: () => void;
  readonly handleRefresh: () => void;
  readonly handleSubmitUrl: (next: string) => Promise<void>;
  readonly handleToggleDeviceToolbar: () => void;
  readonly isServerTab: boolean;
  readonly isUnreachable: boolean;
  readonly layoutZoomFactor: number;
  readonly loading: boolean;
  readonly miniPlayerTabId: string | null;
  readonly moreMenuActions: PreviewMoreMenuActions | null;
  readonly moveLabel: string;
  readonly moveTarget: "desktop" | "server" | null;
  readonly navStatus: { readonly _tag: "Idle"; } | { readonly _tag: "Loading"; readonly url: string; readonly title: string; } | { readonly _tag: "Success"; readonly url: string; readonly title: string; } | { readonly _tag: "LoadFailed"; readonly url: string; readonly title: string; readonly code: number; readonly description: string; readonly download?: { readonly id: string; readonly fileName: string; } | undefined; };
  readonly pickActive: boolean;
  readonly previewBridge: { captureScreenshot: (tabId: string) => Promise<DesktopPreviewScreenshotArtifact>; recording: { startScreencast: (tabId: string) => Promise<void>; onInput: (listener: (event: DesktopPreviewRecordingInputEvent) => void) => () => void; stopScreencast: (tabId: string) => Promise<void>; save: (tabId: string, mimeType: string, data: Uint8Array) => Promise<DesktopPreviewRecordingArtifact>; }; setForwardedShortcuts: (shortcuts: ReadonlyArray<PreviewForwardedShortcut>) => Promise<void>; createTab: (tabId: string, defaults?: DesktopPreviewTabDefaults) => Promise<void>; closeTab: (tabId: string) => Promise<void>; registerWebview: (tabId: string, webContentsId: number) => Promise<void>; navigate: (tabId: string, url: string) => Promise<void>; goBack: (tabId: string) => Promise<void>; goForward: (tabId: string) => Promise<void>; refresh: (tabId: string) => Promise<void>; zoomIn: (tabId: string) => Promise<void>; zoomOut: (tabId: string) => Promise<void>; resetZoom: (tabId: string) => Promise<void>; setZoomFactor: (tabId: string, zoomFactor: number) => Promise<void>; hardReload: (tabId: string) => Promise<void>; setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => Promise<void>; setAudioMuted: (tabId: string, audioMuted: boolean) => Promise<void>; openDevTools: (tabId: string) => Promise<void>; clearCookies: (environmentId: EnvironmentId, profileId?: string) => Promise<void>; clearCache: (environmentId: EnvironmentId, profileId?: string) => Promise<void>; getPreviewConfig: (environmentId: EnvironmentId, profileId?: string) => Promise<DesktopPreviewWebviewConfig>; listBrowserImportSources: () => Promise<ReadonlyArray<BrowserImportSource>>; importBrowserCookies: (input: { readonly environmentId: EnvironmentId; readonly sourceId: BrowserImportSourceId; readonly sourceProfileDirectory: string; readonly targetProfileId: string; }) => Promise<BrowserImportResult>; setAnnotationTheme: (theme: DesktopPreviewAnnotationTheme) => Promise<void>; setAnnotationSendEnabled: (tabId: string, enabled: boolean) => Promise<void>; pickElement: (tabId: string) => Promise<PreviewAnnotationSubmissionResult | null>; cancelPickElement: (tabId: string) => Promise<void>; revealArtifact: (path: string) => Promise<void>; copyArtifactToClipboard: (path: string) => Promise<void>; pictureInPicture: { open: (tabId: string) => Promise<void>; close: (tabId: string) => Promise<void>; }; onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void; onPointerEvent: (listener: (event: DesktopPreviewPointerEvent) => void) => () => void; onOpenLink: (listener: (event: DesktopPreviewOpenLinkEvent) => void) => () => void; } | null;
  readonly previewPdfAssetUrl: (rawUrl: string, httpBaseUrl: string | null) => string | null;
  readonly recentHistoryEntries: readonly BrowserHistoryEntry[];
  readonly recordingRuntimeTabId: string | null;
  readonly refreshDisabled: boolean;
  readonly removeUrlForThread: (ref: ScopedThreadRef, url: string) => void;
  readonly runtimeTabId: string | null;
  readonly scopedThreadKey: (ref: ScopedThreadRef) => string;
  readonly serverAspectRatioLocked: boolean;
  readonly serverBodyRef: RefObject<HTMLDivElement | null>;
  readonly serverInputDisabled: boolean;
  readonly serverOwnsRendering: boolean;
  readonly serverStreamPending: boolean;
  readonly serverSurfaceRef: RefObject<ServerBrowserHandle | null>;
  readonly serverToolbarWidth: number;
  readonly serverZoomFactor: 1 | 2 | 4 | 3 | 0.25 | 0.33 | 0.5 | 0.67 | 0.75 | 0.8 | 0.9 | 1.1 | 1.25 | 1.5 | 1.75 | 2.5 | 5;
  readonly setServerAspectRatioLocked: Dispatch<SetStateAction<boolean>>;
  readonly setServerControlledTabId: Dispatch<SetStateAction<string | null>>;
  readonly setServerFrameTabId: Dispatch<SetStateAction<string | null>>;
  readonly showEmptyState: boolean;
  readonly showPreviewPopup: (threadRef: ScopedThreadRef, popupTabId: string, from: "panel" | "floating") => void;
  readonly snapshot: { readonly threadId: string; readonly tabId: string; readonly navStatus: { readonly _tag: "Idle"; } | { readonly _tag: "Loading"; readonly url: string; readonly title: string; } | { readonly _tag: "Success"; readonly url: string; readonly title: string; } | { readonly _tag: "LoadFailed"; readonly url: string; readonly title: string; readonly code: number; readonly description: string; readonly download?: { readonly id: string; readonly fileName: string; } | undefined; }; readonly canGoBack: boolean; readonly canGoForward: boolean; readonly updatedAt: string; readonly viewport?: { readonly _tag: "freeform"; readonly width: number; readonly height: number; } | { readonly _tag: "preset"; readonly presetId: "iphone-se" | "iphone-xr" | "iphone-12-pro" | "iphone-14-pro-max" | "pixel-7" | "samsung-galaxy-s8-plus" | "samsung-galaxy-s20-ultra" | "ipad-mini" | "ipad-air" | "ipad-pro" | "surface-pro-7" | "surface-duo" | "galaxy-z-fold-5" | "asus-zenbook-fold" | "samsung-galaxy-a51-71" | "nest-hub" | "nest-hub-max" | "desktop-1920x1080" | "desktop-1440x900" | "laptop-1366x768" | "laptop-1280x800" | "ipad-pro-11" | "iphone-15-pro" | "pixel-8" | "galaxy-s24"; readonly width: number; readonly height: number; } | { readonly _tag: "fill"; } | undefined; readonly colorScheme?: "system" | "light" | "dark" | undefined; readonly zoomFactor?: 1 | 2 | 4 | 3 | 0.25 | 0.33 | 0.5 | 0.67 | 0.75 | 0.8 | 0.9 | 1.1 | 1.25 | 1.5 | 1.75 | 2.5 | 5 | undefined; readonly profileId?: string | undefined; readonly runtime?: "desktop" | "server" | undefined; readonly headless?: boolean | undefined; readonly automationOwner?: string | undefined; readonly reveal?: boolean | undefined; readonly revealRequest?: { readonly id: string; readonly force: boolean; } | undefined; } | null;
  readonly tabId: string | null;
  readonly threadRef: { readonly environmentId: string & Brand<"EnvironmentId">; readonly threadId: string & Brand<"ThreadId">; };
  readonly url: string;
  readonly urlInputRef: RefObject<HTMLInputElement | null>;
  readonly viewport: { readonly _tag: "freeform"; readonly width: number; readonly height: number; } | { readonly _tag: "preset"; readonly presetId: "iphone-se" | "iphone-xr" | "iphone-12-pro" | "iphone-14-pro-max" | "pixel-7" | "samsung-galaxy-s8-plus" | "samsung-galaxy-s20-ultra" | "ipad-mini" | "ipad-air" | "ipad-pro" | "surface-pro-7" | "surface-duo" | "galaxy-z-fold-5" | "asus-zenbook-fold" | "samsung-galaxy-a51-71" | "nest-hub" | "nest-hub-max" | "desktop-1920x1080" | "desktop-1440x900" | "laptop-1366x768" | "laptop-1280x800" | "ipad-pro-11" | "iphone-15-pro" | "pixel-8" | "galaxy-s24"; readonly width: number; readonly height: number; } | { readonly _tag: "fill"; };
  readonly visible: boolean;
}

export function PreviewViewSurface(props: PreviewViewSurfaceProps) {
  const {
    activeProfileId,
    activeProfileName,
    activeRecordingTabIds,
    BROWSER_DEVICE_TOOLBAR_HEIGHT,
    browserDefaults,
    canGoBack,
    canGoForward,
    cn,
    commitBrowserViewportChange,
    configuredUrls,
    controller,
    desktopOverlay,
    environmentHttpBaseUrl,
    handleBack,
    handleCapture,
    handleForward,
    handleMoveTab,
    handleOpenInBrowser,
    handleOpenServerUrl,
    handlePickElement,
    handlePictureInPicture,
    handleRefresh,
    handleSubmitUrl,
    handleToggleDeviceToolbar,
    isServerTab,
    isUnreachable,
    layoutZoomFactor,
    loading,
    miniPlayerTabId,
    moreMenuActions,
    moveLabel,
    moveTarget,
    navStatus,
    pickActive,
    previewBridge,
    previewPdfAssetUrl,
    recentHistoryEntries,
    recordingRuntimeTabId,
    refreshDisabled,
    removeUrlForThread,
    runtimeTabId,
    scopedThreadKey,
    serverAspectRatioLocked,
    serverBodyRef,
    serverInputDisabled,
    serverOwnsRendering,
    serverStreamPending,
    serverSurfaceRef,
    serverToolbarWidth,
    serverZoomFactor,
    setServerAspectRatioLocked,
    setServerControlledTabId,
    setServerFrameTabId,
    showEmptyState,
    showPreviewPopup,
    snapshot,
    tabId,
    threadRef,
    url,
    urlInputRef,
    viewport,
    visible,
  } = props;
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
        urlInputRef={urlInputRef}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
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
        pickDisabled={!tabId || isUnreachable}
        pickDisabledReason={
          isUnreachable ? "Page didn't load. Pick is unavailable until the page renders" : undefined
        }
        leadingActions={
          activeProfileId !== browserDefaults.profileId ? (
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
              {...(moveTarget
                ? { move: { label: moveLabel, onMove: () => void handleMoveTab() } }
                : {})}
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
                  onChange={(setting) =>
                    commitBrowserViewportChange(
                      { threadRef, tabId: snapshot.tabId, runtimeTabId },
                      setting,
                    )
                  }
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
                pdfUrl={
                  navStatus._tag === "Success"
                    ? previewPdfAssetUrl(url, environmentHttpBaseUrl)
                    : null
                }
                visible={visible}
                onFirstFrame={() => setServerFrameTabId(runtimeTabId)}
                onControl={(control) =>
                  setServerControlledTabId(control?.controller === "you" ? runtimeTabId : null)
                }
                onPopup={(popupTabId) => showPreviewPopup(threadRef, popupTabId, "panel")}
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
            zoomFactor={layoutZoomFactor}
            controller={controller}
          />
        ) : null}
        {navStatus._tag === "LoadFailed" && navStatus.download ? (
          <div className="absolute inset-0 z-10 bg-background">
            <ServerTabFileNotShown
              threadRef={threadRef}
              tabId={snapshot?.tabId ?? ""}
              url={navStatus.url}
              download={navStatus.download}
            />
          </div>
        ) : navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
              {...(moveTarget === "server"
                ? { move: { label: moveLabel, onMove: () => void handleMoveTab() } }
                : {})}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
