import {
  PreviewManifest,
  PreviewRenderControlMessage,
  PreviewRenderMessage,
  type EnvironmentId,
  type PreviewManifestEntry,
  type PreviewRenderMessage as PreviewRenderMessageValue,
  type ThreadId,
} from "@forma/contracts";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import {
  type PointerEvent as ReactPointerEvent,
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { PinIcon, RotateCcwIcon, SearchIcon, XIcon } from "lucide-react";

import { DEFAULT_THREAD_PREVIEW_HEIGHT } from "~/types";
import type { WorkLogEntry } from "~/session-logic";
import { usePreviewSession } from "~/hooks/usePreviewSession";
import { usePreviewStateStore } from "~/previewStateStore";
import type { PreviewViewportMode } from "~/previewStateStore";
import {
  buildChangedFilesSignature,
  buildPreviewRenderUrl,
  deriveChangedPreviewTabs,
  previewAvailabilityForEnvironment,
  previewCaseLabel,
  resolveViewportWidth,
  viewportModeLabel,
} from "~/lib/previewSupport";

interface ThreadPreviewDrawerProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly projectCwd: string | null;
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | undefined;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly resolvedTheme: "light" | "dark";
  readonly height: number;
  readonly onHeightChange: (height: number) => void;
  readonly onClose: () => void;
}

interface IframeTarget {
  readonly previewId: string;
  readonly theme: "light" | "dark";
  readonly token: string;
  readonly src: string;
}

const VIEWPORT_OPTIONS: PreviewViewportMode[] = ["auto", "responsive", "sm", "md", "lg", "xl"];
const PROBE_TIMEOUT_MS = 10_000;
const EMPTY_PREVIEW_ENTRIES: ReadonlyArray<PreviewManifestEntry> = [];
const MIN_DRAWER_HEIGHT = 240;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_PREVIEW_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_PREVIEW_HEIGHT;
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxDrawerHeight());
}

function createIframeTarget(input: {
  readonly baseUrl: string;
  readonly previewId: string;
  readonly caseId: string;
  readonly theme: "light" | "dark";
  readonly viewportWidth: number | null;
}): IframeTarget {
  const token = crypto.randomUUID();
  return {
    previewId: input.previewId,
    theme: input.theme,
    token,
    src: buildPreviewRenderUrl({
      baseUrl: input.baseUrl,
      previewId: input.previewId,
      caseId: input.caseId,
      theme: input.theme,
      viewportWidth: input.viewportWidth,
      token,
    }),
  };
}

async function fetchPreviewManifest(manifestUrl: string) {
  const response = await fetch(manifestUrl, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Preview manifest responded with ${response.status}.`);
  }
  return Schema.decodeUnknownSync(PreviewManifest)(await response.json());
}

export default memo(function ThreadPreviewDrawer({
  environmentId,
  threadId,
  threadKey,
  projectCwd,
  worktreePath,
  workspaceRoot,
  workEntries,
  resolvedTheme,
  height,
  onHeightChange,
  onClose,
}: ThreadPreviewDrawerProps) {
  const availability = previewAvailabilityForEnvironment(environmentId, projectCwd !== null);
  const threadPreviewState = usePreviewStateStore((state) => state.byThreadKey[threadKey] ?? null);
  const setSelectedPreview = usePreviewStateStore((state) => state.setSelectedPreview);
  const setSelectedCase = usePreviewStateStore((state) => state.setSelectedCase);
  const setPinned = usePreviewStateStore((state) => state.setPinned);
  const setViewportMode = usePreviewStateStore((state) => state.setViewportMode);
  const [allPreviewFilter, setAllPreviewFilter] = useState("");
  const [visibleTarget, setVisibleTarget] = useState<IframeTarget | null>(null);
  const [probeTarget, setProbeTarget] = useState<IframeTarget | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [caseError, setCaseError] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const visibleIframeRef = useRef<HTMLIFrameElement | null>(null);
  const probeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const visibleTargetRef = useRef<IframeTarget | null>(null);
  const probeTargetRef = useRef<IframeTarget | null>(null);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    visibleTargetRef.current = visibleTarget;
  }, [visibleTarget]);

  useEffect(() => {
    probeTargetRef.current = probeTarget;
  }, [probeTarget]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) {
      return;
    }
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
    },
    [syncHeight],
  );

  useEffect(() => {
    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  const { snapshot, openError, restart } = usePreviewSession({
    open: true,
    environmentId,
    threadId,
    cwd: availability.supported ? projectCwd : null,
    worktreePath,
  });

  const changedFilesSignature = useMemo(
    () => buildChangedFilesSignature(workEntries),
    [workEntries],
  );

  const manifestQuery = useQuery({
    queryKey: [
      "previewManifest",
      snapshot?.manifestUrl ?? null,
      snapshot?.status === "ready" ? (snapshot.startedAt ?? snapshot.updatedAt) : null,
      changedFilesSignature,
    ],
    queryFn: () => fetchPreviewManifest(snapshot!.manifestUrl!),
    enabled: snapshot?.status === "ready" && !!snapshot?.manifestUrl,
    staleTime: 0,
    retry: 2,
  });

  const manifestEntries = manifestQuery.data?.entries ?? EMPTY_PREVIEW_ENTRIES;
  const emptyManifestHint = useMemo(() => {
    if (!availability.supported) {
      return availability.reason ?? "Preview is unavailable for this environment.";
    }
    if (openError) {
      return "Preview failed to open. See the session error details below.";
    }
    if (snapshot?.status === "unsupported") {
      return snapshot.error?.message ?? "Preview is unsupported for this workspace.";
    }
    if (snapshot?.status === "error") {
      return snapshot.error?.message ?? "Preview server failed to start.";
    }
    if (snapshot?.status === "starting" || manifestQuery.isPending || manifestQuery.isFetching) {
      return "Loading preview manifest…";
    }
    if (manifestQuery.error instanceof Error) {
      return "Preview manifest failed to load. See the session error details below.";
    }
    if (snapshot?.status === "ready" && manifestEntries.length === 0) {
      return "No preview files matched the current Forma preview scan. This repo scans apps/web/src/**/*.preview.tsx from forma.preview.ts, so packaged desktop installs will not surface previews unless the source checkout is the active project.";
    }
    return null;
  }, [
    availability.reason,
    availability.supported,
    manifestEntries.length,
    manifestQuery.error,
    manifestQuery.isFetching,
    manifestQuery.isPending,
    openError,
    snapshot?.error?.message,
    snapshot?.status,
  ]);
  const changedPreviewTabs = useMemo(
    () =>
      deriveChangedPreviewTabs({
        workEntries,
        previewEntries: manifestEntries,
        workspaceRoot: workspaceRoot ?? projectCwd,
      }),
    [manifestEntries, projectCwd, workEntries, workspaceRoot],
  );
  const autoPreviewId = changedPreviewTabs[0]?.id ?? null;
  const selectedPreviewId = threadPreviewState?.selectedPreviewId ?? null;
  const isPinned = threadPreviewState?.pinned ?? false;
  const viewportMode = threadPreviewState?.viewportMode ?? "auto";

  const selectedPreview = useMemo(
    () => manifestEntries.find((entry) => entry.id === selectedPreviewId) ?? null,
    [manifestEntries, selectedPreviewId],
  );
  const selectedCaseId =
    selectedPreview &&
    (threadPreviewState?.selectedCaseByPreviewId[selectedPreview.id] ??
      selectedPreview.defaultCaseId);
  const selectedCase =
    selectedPreview?.cases.find((caseEntry) => caseEntry.id === selectedCaseId) ?? null;
  const viewportWidth = resolveViewportWidth(viewportMode, selectedCase?.viewport);

  useEffect(() => {
    if (manifestEntries.length === 0) {
      return;
    }

    const previewExists =
      selectedPreviewId !== null && manifestEntries.some((entry) => entry.id === selectedPreviewId);
    if (!previewExists) {
      const fallbackPreviewId = autoPreviewId ?? manifestEntries[0]!.id;
      setSelectedPreview(threadKey, fallbackPreviewId);
      return;
    }

    if (!isPinned && autoPreviewId && autoPreviewId !== selectedPreviewId) {
      setSelectedPreview(threadKey, autoPreviewId);
    }
  }, [autoPreviewId, isPinned, manifestEntries, selectedPreviewId, setSelectedPreview, threadKey]);

  useEffect(() => {
    if (!selectedPreview || !selectedCaseId) {
      return;
    }

    const caseExists = selectedPreview.cases.some((caseEntry) => caseEntry.id === selectedCaseId);
    if (!caseExists) {
      setSelectedCase(threadKey, selectedPreview.id, selectedPreview.defaultCaseId);
    }
  }, [selectedCaseId, selectedPreview, setSelectedCase, threadKey]);

  useEffect(() => {
    if (!snapshot?.baseUrl || !selectedPreview || !selectedCaseId) {
      return;
    }

    const nextTarget = createIframeTarget({
      baseUrl: snapshot.baseUrl,
      previewId: selectedPreview.id,
      caseId: selectedCaseId,
      theme: resolvedTheme,
      viewportWidth,
    });

    if (!visibleTarget) {
      setVisibleTarget(nextTarget);
      setPanelError(null);
      setCaseError(null);
      return;
    }

    if (
      visibleTarget.previewId === nextTarget.previewId &&
      visibleTarget.theme === nextTarget.theme
    ) {
      return;
    }

    setProbeTarget(nextTarget);
    setPanelError(`Updating preview to ${selectedPreview.label}…`);
  }, [
    resolvedTheme,
    selectedCaseId,
    selectedPreview,
    snapshot?.baseUrl,
    viewportWidth,
    visibleTarget,
  ]);

  useEffect(() => {
    if (!probeTarget) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setPanelError(`Preview switch timed out for ${probeTarget.previewId}.`);
      setProbeTarget(null);
      if (visibleTargetRef.current) {
        setSelectedPreview(threadKey, visibleTargetRef.current.previewId);
      }
    }, PROBE_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [probeTarget, setSelectedPreview, threadKey]);

  useEffect(() => {
    if (!visibleTarget || !selectedPreview || !selectedCaseId) {
      return;
    }
    if (visibleTarget.previewId !== selectedPreview.id) {
      return;
    }

    const controlMessage = Schema.encodeSync(PreviewRenderControlMessage)({
      source: "forma-preview-parent",
      type: "update",
      loadToken: visibleTarget.token,
      caseId: selectedCaseId,
      viewportWidth,
    });

    visibleIframeRef.current?.contentWindow?.postMessage(controlMessage, "*");
  }, [selectedCaseId, selectedPreview, viewportWidth, visibleTarget]);

  const handlePreviewMessage = useEffectEvent((event: MessageEvent<unknown>) => {
    let message: PreviewRenderMessageValue | null = null;
    try {
      message = Schema.decodeUnknownSync(PreviewRenderMessage)(event.data);
    } catch {
      return;
    }

    const probeTargetValue = probeTargetRef.current;
    if (
      probeTargetValue &&
      event.source === probeIframeRef.current?.contentWindow &&
      message.loadToken === probeTargetValue.token
    ) {
      if (message.type === "ready") {
        setVisibleTarget(probeTargetValue);
        setProbeTarget(null);
        setPanelError(null);
        setCaseError(null);
        return;
      }

      setPanelError(message.message);
      setProbeTarget(null);
      if (visibleTargetRef.current) {
        setSelectedPreview(threadKey, visibleTargetRef.current.previewId);
      }
      return;
    }

    const visibleTargetValue = visibleTargetRef.current;
    if (
      visibleTargetValue &&
      event.source === visibleIframeRef.current?.contentWindow &&
      message.loadToken === visibleTargetValue.token
    ) {
      if (message.type === "ready") {
        setPanelError(null);
        setCaseError(null);
      } else {
        setCaseError(message.message);
      }
    }
  });

  useEffect(() => {
    window.addEventListener("message", handlePreviewMessage as EventListener);
    return () => {
      window.removeEventListener("message", handlePreviewMessage as EventListener);
    };
  }, []);

  const filteredAllPreviews = useMemo(() => {
    const query = allPreviewFilter.trim().toLowerCase();
    if (query.length === 0) {
      return manifestEntries;
    }
    return manifestEntries.filter((entry) => entry.label.toLowerCase().includes(query));
  }, [allPreviewFilter, manifestEntries]);

  const handleSelectPreview = (previewId: string) => {
    if (!manifestEntries.some((entry) => entry.id === previewId)) {
      return;
    }
    setSelectedPreview(threadKey, previewId);
    setProbeTarget(null);
    setPanelError(null);
    setCaseError(null);
  };

  const handleSelectCase = (caseId: string | null) => {
    if (!selectedPreview || !caseId) {
      return;
    }
    setSelectedCase(threadKey, selectedPreview.id, caseId);
    setProbeTarget(null);
    setPanelError(null);
    setCaseError(null);
  };

  const sessionError =
    openError ?? (manifestQuery.error instanceof Error ? manifestQuery.error.message : null);
  const recentPreviewLogs =
    snapshot?.logs.slice(-4).map((entry) => `[${entry.level}] ${entry.message}`) ?? [];

  const handleRestart = useEffectEvent(async () => {
    setIsRestarting(true);
    setPanelError("Restarting preview server…");
    setCaseError(null);
    setVisibleTarget(null);
    setProbeTarget(null);

    try {
      await restart();
      await manifestQuery.refetch();
      setPanelError(null);
    } catch {
      // usePreviewSession / manifestQuery already surface the error states.
    } finally {
      setIsRestarting(false);
    }
  });

  return (
    <aside
      className="thread-preview-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />

      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-emerald-500 uppercase"
          >
            Preview
          </Badge>
          {snapshot?.status === "starting" ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <Spinner className="size-3" />
              Starting
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => {
              void handleRestart();
            }}
            aria-label="Restart preview server"
            className="text-muted-foreground/50 hover:text-foreground/70"
            disabled={!availability.supported || projectCwd === null || isRestarting}
          >
            {isRestarting ? (
              <Spinner className="size-3.5" />
            ) : (
              <RotateCcwIcon className="size-3.5" />
            )}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close preview drawer"
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="max-h-40 shrink-0 overflow-auto border-b border-border/60">
          <div className="space-y-3 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant={isPinned ? "secondary" : "outline"}
                onClick={() => setPinned(threadKey, !isPinned)}
                disabled={!selectedPreview}
              >
                <PinIcon className="size-3.5" />
                {isPinned ? "Pinned" : "Pin preview"}
              </Button>
              <Select
                value={viewportMode}
                onValueChange={(value) => setViewportMode(threadKey, value as PreviewViewportMode)}
              >
                <SelectTrigger size="xs" className="w-36" aria-label="Preview viewport">
                  <SelectValue>{viewportModeLabel(viewportMode)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {VIEWPORT_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option} hideIndicator>
                      {viewportModeLabel(option)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {selectedPreview ? (
                <Select
                  value={selectedCaseId ?? selectedPreview.defaultCaseId}
                  onValueChange={handleSelectCase}
                >
                  <SelectTrigger size="xs" className="w-40" aria-label="Preview case">
                    <SelectValue>
                      {selectedCase ? previewCaseLabel(selectedCase) : "Case"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {selectedPreview.cases.map((caseEntry) => (
                      <SelectItem key={caseEntry.id} value={caseEntry.id} hideIndicator>
                        {previewCaseLabel(caseEntry)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
            </div>

            {changedPreviewTabs.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
                  Changed components
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {changedPreviewTabs.map((entry) => (
                    <Button
                      key={entry.id}
                      size="xs"
                      variant={entry.id === selectedPreviewId ? "secondary" : "outline"}
                      onClick={() => handleSelectPreview(entry.id)}
                    >
                      {entry.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
                All previews
              </p>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  value={allPreviewFilter}
                  onChange={(event) => setAllPreviewFilter(event.target.value)}
                  placeholder="Search previews"
                  className="h-8 pl-7"
                />
              </div>
              <div className="flex max-h-24 flex-wrap gap-1 overflow-auto">
                {filteredAllPreviews.map((entry) => (
                  <Button
                    key={entry.id}
                    size="xs"
                    variant={entry.id === selectedPreviewId ? "secondary" : "ghost"}
                    className="justify-start"
                    onClick={() => handleSelectPreview(entry.id)}
                  >
                    {entry.label}
                  </Button>
                ))}
                {filteredAllPreviews.length === 0 && emptyManifestHint ? (
                  <div className="space-y-1 text-xs text-muted-foreground/70">
                    <p>{emptyManifestHint}</p>
                    {snapshot?.workspaceRoot ? (
                      <p className="font-mono text-[11px] break-all">
                        workspace: {snapshot.workspaceRoot}
                      </p>
                    ) : null}
                    {snapshot?.launchCwd ? (
                      <p className="font-mono text-[11px] break-all">
                        launch: {snapshot.launchCwd}
                      </p>
                    ) : null}
                    {snapshot?.manifestUrl ? (
                      <p className="font-mono text-[11px] break-all">
                        manifest: {snapshot.manifestUrl}
                      </p>
                    ) : null}
                    {recentPreviewLogs.map((line) => (
                      <p key={line} className="font-mono text-[11px] break-all">
                        {line}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          {!availability.supported ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
              {availability.reason}
            </div>
          ) : null}
          {sessionError ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
              {sessionError}
            </div>
          ) : null}
          {panelError ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
              {panelError}
            </div>
          ) : null}
          {caseError ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
              {caseError}
            </div>
          ) : null}

          {snapshot?.status === "unsupported" ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
              {snapshot.error?.message ?? "No forma.preview.ts file was found for this workspace."}
            </div>
          ) : null}

          {snapshot?.status === "error" ? (
            <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100">
              <p>{snapshot.error?.message ?? "Preview failed to start."}</p>
              {snapshot.launchCwd ? (
                <p className="font-mono text-[11px] text-rose-100/80">{snapshot.launchCwd}</p>
              ) : null}
              {snapshot.command.length > 0 ? (
                <p className="font-mono text-[11px] text-rose-100/80">
                  {snapshot.command.join(" ")}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden bg-background">
            {snapshot?.status === "starting" && !visibleTarget ? (
              <div className="flex h-full min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                Starting preview server…
              </div>
            ) : null}

            {visibleTarget ? (
              <iframe
                ref={visibleIframeRef}
                title="Component preview"
                src={visibleTarget.src}
                // The preview server runs on a different loopback port than Forma,
                // so same-origin here restores module/runtime behavior without
                // giving the iframe access to the parent document.
                // eslint-disable-next-line react/iframe-missing-sandbox
                sandbox="allow-scripts allow-same-origin"
                className="block h-full min-h-full w-full border-0 bg-transparent"
              />
            ) : null}
          </div>
        </div>
      </div>

      {probeTarget ? (
        <iframe
          ref={probeIframeRef}
          title="Preview probe"
          src={probeTarget.src}
          // The hidden probe iframe shares the same cross-origin preview runtime
          // constraints as the visible preview iframe.
          // eslint-disable-next-line react/iframe-missing-sandbox
          sandbox="allow-scripts allow-same-origin"
          className="pointer-events-none absolute size-0 opacity-0"
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : null}
    </aside>
  );
});
