import {
  type EnvironmentId,
  type PreviewDiscoveredLocalServer,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BugIcon,
  CameraIcon,
  EraserIcon,
  ExternalLinkIcon,
  LoaderIcon,
  MinusIcon,
  MousePointer2Icon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { previewPartitionForEnvironment } from "@t3tools/shared/preview";
import {
  getDesktopPreviewBridge,
  statusFromWebview,
  type PreviewWebviewElement,
} from "~/previewWebview";
import {
  applyPreviewDesktopState,
  applyPreviewServerSnapshot,
  activatePreviewTab,
  getActivePreviewSnapshot,
  getPreviewSnapshotTitle,
  getPreviewSnapshotUrl,
  markPreviewTabClosed,
  rememberPreviewUrl,
  setPreviewSurfaceRect,
  usePreviewSession,
  useThreadPreviewState,
} from "~/previewStateStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { PreviewDeviceBar, PreviewTabStrip } from "./BrowserPreviewBars";

interface BrowserPreviewPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onClose: () => void;
}

const DEFAULT_PREVIEW_URL = "http://localhost:3000";
function useCanHostDesktopPreview(): boolean {
  const [canHost, setCanHost] = useState(() => isElectron && getDesktopPreviewBridge() !== null);

  useEffect(() => {
    setCanHost(isElectron && getDesktopPreviewBridge() !== null);
  }, []);

  return canHost;
}

const BrowserPreviewSurfaceSlot = memo(function BrowserPreviewSurfaceSlot({
  threadRef,
  snapshot,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: PreviewSessionSnapshot;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const tabId = snapshot.tabId;
  const viewport = snapshot.viewport ?? { _tag: "fill" };

  const updateSurfaceRect = useCallback(() => {
    const element = slotRef.current;
    if (!element) {
      setPreviewSurfaceRect(threadRef, tabId, null);
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      setPreviewSurfaceRect(threadRef, tabId, null);
      return;
    }
    setPreviewSurfaceRect(threadRef, tabId, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [tabId, threadRef]);

  useLayoutEffect(() => {
    const element = slotRef.current;
    if (!element) {
      return;
    }

    let frame: number | null = null;
    const scheduleUpdate = () => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateSurfaceRect();
      });
    };

    updateSurfaceRect();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      setPreviewSurfaceRect(threadRef, tabId, null);
    };
  }, [tabId, threadRef, updateSurfaceRect]);

  if (viewport._tag === "freeform") {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4">
        <div
          ref={slotRef}
          className="mx-auto bg-white shadow-sm ring-1 ring-border"
          style={{ width: viewport.width, height: viewport.height }}
          data-preview-surface-tab-id={tabId}
        />
      </div>
    );
  }

  return (
    <div
      ref={slotRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-white"
      data-preview-surface-tab-id={tabId}
    />
  );
});

export const BrowserPreviewPanel = memo(function BrowserPreviewPanel({
  environmentId,
  threadId,
  onClose,
}: BrowserPreviewPanelProps) {
  const webviewRef = useRef<PreviewWebviewElement | null>(null);
  const [address, setAddress] = useState(DEFAULT_PREVIEW_URL);
  const [isOpening, setIsOpening] = useState(false);
  const [isDiscoveringServers, setIsDiscoveringServers] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<
    readonly PreviewDiscoveredLocalServer[]
  >([]);
  const [isRecording, setIsRecording] = useState(false);
  const [selectorAction, setSelectorAction] = useState<"annotate" | "click" | null>(null);
  const [selectorInput, setSelectorInput] = useState("");
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const api = useMemo(() => readEnvironmentApi(environmentId), [environmentId]);
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = getActivePreviewSnapshot(previewState);

  const activeUrl = getPreviewSnapshotUrl(snapshot);
  const isLoading = snapshot?.navStatus._tag === "Loading";
  const activeDesktopState = snapshot ? previewState.desktopByTabId[snapshot.tabId] : undefined;
  const zoomPercent = Math.round((activeDesktopState?.zoomFactor ?? 1) * 100);
  const canHostDesktopPreview = useCanHostDesktopPreview();
  const previewPartition = useMemo(
    () => previewPartitionForEnvironment(environmentId),
    [environmentId],
  );

  const handlePreviewSessionError = useCallback((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not load browser preview",
        description: error instanceof Error ? error.message : "The preview state could not load.",
      }),
    );
  }, []);

  usePreviewSession(threadRef, { onError: handlePreviewSessionError });

  const reportWebviewStatus = useCallback(
    (tag: "Loading" | "Success") => {
      if (!api || !snapshot) {
        return;
      }
      const webview = webviewRef.current;
      void api.preview
        .reportStatus({
          threadId,
          tabId: snapshot.tabId,
          navStatus: statusFromWebview(webview, activeUrl || address, tag),
          canGoBack: webview?.canGoBack?.() ?? snapshot.canGoBack,
          canGoForward: webview?.canGoForward?.() ?? snapshot.canGoForward,
        })
        .catch((error: unknown) => {
          console.error("[BROWSER_PREVIEW] report status failed", error);
        });
    },
    [activeUrl, address, api, snapshot, threadId],
  );

  useEffect(() => {
    if (activeUrl) {
      setAddress(activeUrl);
    }
  }, [activeUrl]);

  const discoverLocalServers = useCallback(async () => {
    if (!api) {
      return;
    }
    setIsDiscoveringServers(true);
    try {
      const result = await api.preview.discoverLocalServers({});
      setDiscoveredServers(result.servers);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not discover local servers",
          description:
            error instanceof Error ? error.message : "The local server scan did not complete.",
        }),
      );
    } finally {
      setIsDiscoveringServers(false);
    }
  }, [api]);

  useEffect(() => {
    void discoverLocalServers();
  }, [discoverLocalServers]);

  const registerWebviewElement = useCallback(
    (element: HTMLElement | null) => {
      const webview = element as PreviewWebviewElement | null;
      webviewRef.current = webview;

      const tabId = snapshot?.tabId;
      if (!webview || !tabId || !isElectron) {
        return;
      }

      const previewBridge = getDesktopPreviewBridge();
      if (!previewBridge) {
        return;
      }

      const register = () => {
        const webContentsId = webview.getWebContentsId?.();
        if (typeof webContentsId !== "number") {
          return;
        }
        void previewBridge
          .registerWebview({ tabId, webContentsId, partition: previewPartition })
          .then((state) => applyPreviewDesktopState(threadRef, state))
          .catch((error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not attach desktop browser",
                description:
                  error instanceof Error
                    ? error.message
                    : "The desktop browser webview did not attach.",
              }),
            );
          });
      };

      webview.addEventListener("did-attach", register, { once: true });
      queueMicrotask(register);
    },
    [previewPartition, snapshot?.tabId, threadRef],
  );

  const openOrNavigate = useCallback(
    async (url: string) => {
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment disconnected",
            description: "Reconnect this environment before opening a browser preview.",
          }),
        );
        return;
      }
      setIsOpening(true);
      try {
        const nextSnapshot = snapshot
          ? await api.preview.navigate({ threadId, tabId: snapshot.tabId, url })
          : await api.preview.open({ threadId, url });
        applyPreviewServerSnapshot(threadRef, nextSnapshot);
        rememberPreviewUrl(threadRef, getPreviewSnapshotUrl(nextSnapshot) || url);
        setAddress(getPreviewSnapshotUrl(nextSnapshot) || url);
        // On desktop the webview `src` is fixed for the life of the tab (to avoid
        // reload loops), so an explicit navigation of an existing tab must drive
        // the guest through the bridge. A freshly opened tab loads via `src`.
        const previewBridge = getDesktopPreviewBridge();
        if (snapshot && previewBridge) {
          void previewBridge.navigate({
            tabId: nextSnapshot.tabId,
            url: getPreviewSnapshotUrl(nextSnapshot) || url,
          });
        }
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open browser preview",
            description: error instanceof Error ? error.message : "The preview URL could not open.",
          }),
        );
      } finally {
        setIsOpening(false);
      }
    },
    [api, snapshot, threadId, threadRef],
  );

  const openNewPreview = useCallback(async () => {
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment disconnected",
          description: "Reconnect this environment before opening a browser preview.",
        }),
      );
      return;
    }
    setIsOpening(true);
    try {
      const nextSnapshot = await api.preview.open({ threadId, url: address });
      applyPreviewServerSnapshot(threadRef, nextSnapshot);
      activatePreviewTab(threadRef, nextSnapshot.tabId);
      rememberPreviewUrl(threadRef, getPreviewSnapshotUrl(nextSnapshot) || address);
      setAddress(getPreviewSnapshotUrl(nextSnapshot) || address);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open browser preview",
          description: error instanceof Error ? error.message : "The preview URL could not open.",
        }),
      );
    } finally {
      setIsOpening(false);
    }
  }, [address, api, threadId, threadRef]);

  const closeTab = useCallback(
    (tabId: string) => {
      if (api) {
        void api.preview.close({ threadId, tabId });
      }
      markPreviewTabClosed(threadRef, tabId);
      void getDesktopPreviewBridge()?.closeTab({ tabId });
    },
    [api, threadId, threadRef],
  );

  const closePreview = useCallback(() => {
    if (api && snapshot) {
      void api.preview.close({ threadId, tabId: snapshot.tabId });
    }
    if (snapshot) {
      markPreviewTabClosed(threadRef, snapshot.tabId);
      void getDesktopPreviewBridge()?.closeTab({ tabId: snapshot.tabId });
    }
    onClose();
  }, [api, onClose, snapshot, threadId, threadRef]);

  const refreshPreview = useCallback(() => {
    if (!snapshot) {
      void openOrNavigate(address);
      return;
    }
    const previewBridge = getDesktopPreviewBridge();
    if (isElectron && previewBridge) {
      void previewBridge.refresh({ tabId: snapshot.tabId });
    } else if (isElectron) {
      webviewRef.current?.reload?.();
    } else {
      applyPreviewServerSnapshot(threadRef, { ...snapshot, updatedAt: new Date().toISOString() });
    }
    if (api) {
      void api.preview.refresh({ threadId, tabId: snapshot.tabId });
    }
  }, [address, api, openOrNavigate, snapshot, threadId, threadRef]);

  const hardReloadPreview = useCallback(() => {
    if (!snapshot) {
      void openOrNavigate(address);
      return;
    }
    const previewBridge = getDesktopPreviewBridge();
    if (previewBridge) {
      void previewBridge.hardReload({ tabId: snapshot.tabId });
      return;
    }
    webviewRef.current?.reload?.();
  }, [address, openOrNavigate, snapshot]);

  const zoomPreview = useCallback(
    (action: "in" | "out" | "reset") => {
      if (!snapshot) {
        return;
      }
      const previewBridge = getDesktopPreviewBridge();
      if (!previewBridge) {
        return;
      }
      if (action === "in") {
        void previewBridge.zoomIn({ tabId: snapshot.tabId });
        return;
      }
      if (action === "out") {
        void previewBridge.zoomOut({ tabId: snapshot.tabId });
        return;
      }
      void previewBridge.resetZoom({ tabId: snapshot.tabId });
    },
    [snapshot],
  );

  const openDevTools = useCallback(() => {
    if (snapshot) {
      void getDesktopPreviewBridge()?.openDevTools({ tabId: snapshot.tabId });
    }
  }, [snapshot]);

  const clearPreviewStorage = useCallback(() => {
    if (!snapshot) {
      return;
    }
    const previewBridge = getDesktopPreviewBridge();
    if (!previewBridge) {
      return;
    }
    void Promise.all([
      previewBridge.clearCookies({ tabId: snapshot.tabId }),
      previewBridge.clearCache({ tabId: snapshot.tabId }),
    ])
      .then(() => previewBridge.hardReload({ tabId: snapshot.tabId }))
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not clear browser data",
            description:
              error instanceof Error
                ? error.message
                : "The preview cookies and cache could not be cleared.",
          }),
        );
      });
  }, [snapshot]);

  const resizePreview = useCallback(
    (viewport: PreviewViewportSetting) => {
      if (!api || !snapshot) {
        return;
      }
      void api.preview
        .resize({ threadId, tabId: snapshot.tabId, viewport })
        .then((nextSnapshot) => applyPreviewServerSnapshot(threadRef, nextSnapshot))
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not resize preview",
              description:
                error instanceof Error ? error.message : "The preview viewport could not resize.",
            }),
          );
        });
    },
    [api, snapshot, threadId, threadRef],
  );

  const downloadDataUrl = useCallback((filename: string, dataUrl: string) => {
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = filename;
    anchor.click();
  }, []);

  const captureScreenshot = useCallback(() => {
    if (!snapshot) {
      return;
    }
    void getDesktopPreviewBridge()
      ?.captureScreenshot({ tabId: snapshot.tabId })
      .then((result) => {
        downloadDataUrl(`preview-${result.tabId}-${result.capturedAt}.png`, result.dataUrl);
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not capture screenshot",
            description:
              error instanceof Error ? error.message : "The preview screenshot could not be saved.",
          }),
        );
      });
  }, [downloadDataUrl, snapshot]);

  const toggleRecording = useCallback(() => {
    if (!snapshot) {
      return;
    }
    const previewBridge = getDesktopPreviewBridge();
    if (!previewBridge) {
      return;
    }
    if (!isRecording) {
      void previewBridge
        .startRecording({ tabId: snapshot.tabId })
        .then(() => setIsRecording(true))
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start recording",
              description:
                error instanceof Error ? error.message : "The preview recording could not start.",
            }),
          );
        });
      return;
    }
    void previewBridge
      .stopRecording({ tabId: snapshot.tabId })
      .then((result) => {
        setIsRecording(false);
        const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        try {
          downloadDataUrl(`preview-recording-${result.tabId}-${result.stoppedAt}.json`, url);
        } finally {
          URL.revokeObjectURL(url);
        }
      })
      .catch((error: unknown) => {
        setIsRecording(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not stop recording",
            description:
              error instanceof Error ? error.message : "The preview recording could not stop.",
          }),
        );
      });
  }, [downloadDataUrl, isRecording, snapshot]);

  const annotatePreviewElement = useCallback(() => {
    if (!snapshot) {
      return;
    }
    setSelectorInput("body");
    setSelectorAction("annotate");
  }, [snapshot]);

  const runPreviewAutomation = useCallback(() => {
    if (!snapshot) {
      return;
    }
    setSelectorInput("button");
    setSelectorAction("click");
  }, [snapshot]);

  const submitSelectorAction = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const selector = selectorInput.trim();
      if (!snapshot || !selectorAction || !selector) return;

      const operation =
        selectorAction === "annotate"
          ? getDesktopPreviewBridge()?.annotateElement({ tabId: snapshot.tabId, selector })
          : getDesktopPreviewBridge()?.runAutomation({
              type: "click",
              tabId: snapshot.tabId,
              selector,
            });
      void operation
        ?.then(() => setSelectorAction(null))
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                selectorAction === "annotate"
                  ? "Could not annotate preview"
                  : "Could not click element",
              description:
                error instanceof Error ? error.message : "The selector operation failed.",
            }),
          );
        });
    },
    [selectorAction, selectorInput, snapshot],
  );

  const submitAddress = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void openOrNavigate(address);
    },
    [address, openOrNavigate],
  );

  const iframeKey = snapshot ? `${snapshot.tabId}:${snapshot.updatedAt}` : "empty";
  const hasHostedSurface = canHostDesktopPreview && snapshot !== null && activeUrl.length > 0;
  const isLoadFailed = snapshot?.navStatus._tag === "LoadFailed";

  return (
    <aside className="flex w-[min(42vw,620px)] min-w-[360px] max-w-[720px] flex-col border-l border-border bg-background">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          disabled={!snapshot?.canGoBack}
          onClick={() => {
            if (snapshot) {
              const previewBridge = getDesktopPreviewBridge();
              if (previewBridge) {
                void previewBridge.goBack({ tabId: snapshot.tabId });
                return;
              }
            }
            webviewRef.current?.goBack?.();
          }}
          aria-label="Go back"
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          disabled={!snapshot?.canGoForward}
          onClick={() => {
            if (snapshot) {
              const previewBridge = getDesktopPreviewBridge();
              if (previewBridge) {
                void previewBridge.goForward({ tabId: snapshot.tabId });
                return;
              }
            }
            webviewRef.current?.goForward?.();
          }}
          aria-label="Go forward"
        >
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={refreshPreview}
          aria-label="Refresh preview"
        >
          <RefreshCwIcon className={cn("size-3.5", isLoading && "animate-spin")} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={hardReloadPreview}
          aria-label="Hard reload preview"
        >
          <RotateCcwIcon className="size-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={submitAddress}>
          <Input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className="h-8"
            aria-label="Preview URL"
            placeholder={DEFAULT_PREVIEW_URL}
          />
        </form>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => void openNewPreview()}
          disabled={isOpening}
          aria-label="Open new preview tab"
        >
          {isOpening ? (
            <LoaderIcon className="size-3 animate-spin" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          disabled={!activeUrl}
          onClick={() => {
            if (activeUrl) {
              window.open(activeUrl, "_blank", "noopener,noreferrer");
            }
          }}
          aria-label="Open externally"
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={closePreview}
          aria-label="Close browser preview"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <PreviewTabStrip
        threadRef={threadRef}
        sessions={previewState.sessions}
        activeTabId={snapshot?.tabId}
        onCloseTab={closeTab}
      />
      {snapshot ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3 text-xs text-muted-foreground">
          <span
            className={cn(
              "mr-auto truncate",
              isLoadFailed
                ? "text-destructive"
                : isLoading
                  ? "text-amber-600"
                  : "text-muted-foreground",
            )}
            title={activeUrl}
          >
            {isLoadFailed
              ? `Failed: ${snapshot.navStatus.description}`
              : isLoading
                ? "Loading..."
                : activeUrl}
          </span>
          {canHostDesktopPreview ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => zoomPreview("out")}
                aria-label="Zoom out preview"
              >
                <MinusIcon className="size-3" />
              </Button>
              <button
                type="button"
                className="rounded px-1.5 py-1 tabular-nums hover:bg-muted"
                onClick={() => zoomPreview("reset")}
                aria-label="Reset preview zoom"
              >
                {zoomPercent}%
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => zoomPreview("in")}
                aria-label="Zoom in preview"
              >
                <PlusIcon className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={openDevTools}
                aria-label="Open preview developer tools"
              >
                <BugIcon className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={clearPreviewStorage}
                aria-label="Clear preview cookies and cache"
              >
                <EraserIcon className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={captureScreenshot}
                aria-label="Capture preview screenshot"
              >
                <CameraIcon className="size-3" />
              </Button>
              <Button
                type="button"
                variant={isRecording ? "secondary" : "ghost"}
                size="icon"
                className="size-6"
                onClick={toggleRecording}
                aria-label={isRecording ? "Stop preview recording" : "Start preview recording"}
              >
                <VideoIcon className={cn("size-3", isRecording && "text-destructive")} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={annotatePreviewElement}
                aria-label="Annotate preview element"
              >
                <MousePointer2Icon className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={runPreviewAutomation}
                aria-label="Run preview automation click"
              >
                <BugIcon className="size-3" />
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {snapshot && selectorAction ? (
        <form
          className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3"
          onSubmit={submitSelectorAction}
        >
          <Input
            autoFocus
            value={selectorInput}
            onChange={(event) => setSelectorInput(event.target.value)}
            className="h-7 flex-1 font-mono text-xs"
            aria-label={`CSS selector to ${selectorAction}`}
          />
          <Button type="submit" size="sm" className="h-7">
            {selectorAction === "annotate" ? "Annotate" : "Click"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => setSelectorAction(null)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {snapshot ? (
        <PreviewDeviceBar
          viewport={snapshot.viewport}
          isDiscoveringServers={isDiscoveringServers}
          onResize={resizePreview}
          onDiscoverServers={() => void discoverLocalServers()}
        />
      ) : null}
      {discoveredServers.length > 0 ? (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
          <span className="shrink-0 px-1 text-[11px] text-muted-foreground">Local</span>
          {discoveredServers.map((server) => (
            <button
              key={server.url}
              type="button"
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              title={server.title ?? server.url}
              onClick={() => {
                setAddress(server.url);
                void openOrNavigate(server.url);
              }}
            >
              {server.title ? `${server.title} ` : null}
              {server.port}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {snapshot && activeUrl ? (
          hasHostedSurface ? (
            <BrowserPreviewSurfaceSlot threadRef={threadRef} snapshot={snapshot} />
          ) : isElectron ? (
            <webview
              ref={registerWebviewElement}
              src={activeUrl}
              className="min-h-0 flex-1"
              partition={previewPartition}
              allowpopups
              onLoadStart={() => reportWebviewStatus("Loading")}
              onLoad={() => reportWebviewStatus("Success")}
            />
          ) : (
            <iframe
              key={iframeKey}
              src={activeUrl}
              title={getPreviewSnapshotTitle(snapshot)}
              className="min-h-0 flex-1 border-0 bg-white"
              sandbox="allow-forms allow-modals allow-popups allow-scripts"
              onLoad={() => reportWebviewStatus("Success")}
            />
          )
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="text-sm font-medium text-foreground">No browser preview open</div>
            <p className="max-w-sm text-xs text-muted-foreground">
              Open a local development URL to preview it beside this chat.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => void openOrNavigate(address)}
              disabled={isOpening}
            >
              {isOpening ? <LoaderIcon className="mr-2 size-3 animate-spin" /> : null}
              Open preview
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
});
