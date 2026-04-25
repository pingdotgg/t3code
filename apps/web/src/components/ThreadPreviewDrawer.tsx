import {
  type PreviewCatalogEntry,
  type PreviewControlValueMap,
  type PreviewScopedEntry,
  PreviewRenderMessage,
  type EnvironmentId,
  type PreviewRenderControlMessage as PreviewRenderControlMessageValue,
  type PreviewRenderMessage as PreviewRenderMessageValue,
  type ThreadId,
} from "@forma/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { PreviewCatalogTree } from "./preview/PreviewCatalogTree";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { PinIcon, RotateCcwIcon, SearchIcon, XIcon } from "lucide-react";

import { DEFAULT_THREAD_PREVIEW_HEIGHT } from "~/types";
import { readEnvironmentApi } from "~/environmentApi";
import type { WorkLogEntry } from "~/session-logic";
import { usePreviewSession } from "~/hooks/usePreviewSession";
import { usePreviewStateStore } from "~/previewStateStore";
import type { PreviewViewportMode } from "~/previewStateStore";
import {
  buildChangedFilesSignature,
  buildPreviewRenderUrl,
  controlLabel,
  defaultControlValuesForGeneration,
  mergeControlValuesForGeneration,
  previewAvailabilityForEnvironment,
  previewCaseLabel,
  resolveViewportWidth,
  viewportModeLabel,
} from "~/lib/previewSupport";
import { buildPreviewSetupScaffold } from "~/lib/previewSetup";
import { normalizeProjectFileEditError } from "~/lib/projectFileEditing";
import { toastManager } from "./ui/toast";

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
  readonly renderToken: string;
  readonly theme: "light" | "dark";
  readonly token: string;
  readonly src: string;
}

type PreviewSelectableEntry = PreviewCatalogEntry | PreviewScopedEntry;

const VIEWPORT_OPTIONS: PreviewViewportMode[] = ["auto", "responsive", "sm", "md", "lg", "xl"];
const PROBE_TIMEOUT_MS = 10_000;
const EMPTY_SCOPED_ENTRIES: ReadonlyArray<PreviewScopedEntry> = [];
const EMPTY_PREVIEW_ENTRIES: ReadonlyArray<PreviewSelectableEntry> = [];
const EMPTY_CONTROL_VALUES: PreviewControlValueMap = {};
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
  readonly renderToken: string;
  readonly caseId: string;
  readonly theme: "light" | "dark";
  readonly viewportWidth: number | null;
}): IframeTarget {
  const token = crypto.randomUUID();
  return {
    previewId: input.previewId,
    renderToken: input.renderToken,
    theme: input.theme,
    token,
    src: buildPreviewRenderUrl({
      baseUrl: input.baseUrl,
      previewId: input.previewId,
      caseId: input.caseId,
      theme: input.theme,
      viewportWidth: input.viewportWidth,
      token,
      renderToken: input.renderToken,
    }),
  };
}

async function fetchPreviewCatalog(environmentId: EnvironmentId, threadId: ThreadId) {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error("Environment API is unavailable.");
  }
  return api.preview.catalog({ threadId });
}

async function fetchPreviewScope(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly changedFiles: ReadonlyArray<string>;
}) {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) {
    throw new Error("Environment API is unavailable.");
  }
  return api.preview.scope({
    threadId: input.threadId,
    changedFiles: [...input.changedFiles],
    mode: "thread-first",
    hopCount: 1,
    direction: "both",
    visualOnly: true,
  });
}

async function generatePreview(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  componentId: string,
) {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error("Environment API is unavailable.");
  }
  return api.preview.generate({ threadId, componentId });
}

function changedFilesFromWorkEntries(workEntries: ReadonlyArray<WorkLogEntry>): string[] {
  return workEntries.flatMap((entry) => entry.changedFiles ?? []);
}

function isChangedScopedEntry(entry: PreviewScopedEntry): boolean {
  return (
    entry.relationship === "changed" ||
    entry.relationship === "same-file" ||
    (entry.relationship === "legacy" && entry.distance === 0)
  );
}

export default memo(function ThreadPreviewDrawer({
  environmentId,
  threadId,
  threadKey,
  projectCwd,
  worktreePath,
  workspaceRoot: _workspaceRoot,
  workEntries,
  resolvedTheme,
  height,
  onHeightChange,
  onClose,
}: ThreadPreviewDrawerProps) {
  const availability = previewAvailabilityForEnvironment(environmentId, projectCwd !== null);
  const queryClient = useQueryClient();
  const threadPreviewState = usePreviewStateStore((state) => state.byThreadKey[threadKey] ?? null);
  const setSelectedPreview = usePreviewStateStore((state) => state.setSelectedPreview);
  const setSelectedCase = usePreviewStateStore((state) => state.setSelectedCase);
  const setControlValues = usePreviewStateStore((state) => state.setControlValues);
  const setPinned = usePreviewStateStore((state) => state.setPinned);
  const setViewportMode = usePreviewStateStore((state) => state.setViewportMode);
  const [allPreviewFilter, setAllPreviewFilter] = useState("");
  const [visibleTarget, setVisibleTarget] = useState<IframeTarget | null>(null);
  const [frameLoadingState, setFrameLoadingState] = useState<{
    token: string;
    label: string;
  } | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [caseError, setCaseError] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isScaffoldingPreview, setIsScaffoldingPreview] = useState(false);
  const [broaderDiscoveryRequested, setBroaderDiscoveryRequested] = useState(false);
  const [knownEntriesById, setKnownEntriesById] = useState<Record<string, PreviewSelectableEntry>>(
    {},
  );
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const visibleIframeRef = useRef<HTMLIFrameElement | null>(null);
  const visibleTargetRef = useRef<IframeTarget | null>(null);
  const autoRecoveredRenderTokensRef = useRef<Set<string>>(new Set());
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
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  useEffect(() => {
    setKnownEntriesById({});
  }, [threadKey]);

  const setVisiblePreviewTarget = useCallback((nextTarget: IframeTarget | null) => {
    visibleTargetRef.current = nextTarget;
    setVisibleTarget(nextTarget);
  }, []);

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
  const changedFiles = useMemo(() => changedFilesFromWorkEntries(workEntries), [workEntries]);

  const scopeQuery = useQuery({
    queryKey: [
      "previewScope",
      threadId,
      snapshot?.baseUrl ?? null,
      snapshot?.status === "ready" ? (snapshot.startedAt ?? snapshot.updatedAt) : null,
      changedFilesSignature,
    ],
    queryFn: () =>
      fetchPreviewScope({
        environmentId,
        threadId,
        changedFiles,
      }),
    enabled: snapshot?.status === "ready" && !!snapshot?.baseUrl,
    staleTime: 0,
    retry: 2,
  });

  const catalogQuery = useQuery({
    queryKey: [
      "previewCatalog",
      threadId,
      snapshot?.baseUrl ?? null,
      snapshot?.status === "ready" ? (snapshot.startedAt ?? snapshot.updatedAt) : null,
      broaderDiscoveryRequested,
    ],
    queryFn: () => fetchPreviewCatalog(environmentId, threadId),
    enabled: broaderDiscoveryRequested && snapshot?.status === "ready" && !!snapshot?.baseUrl,
    staleTime: Infinity,
    retry: 2,
  });

  const scopeEntries = scopeQuery.data?.entries ?? EMPTY_SCOPED_ENTRIES;
  const broaderEntries = broaderDiscoveryRequested
    ? ((catalogQuery.data?.entries ??
        EMPTY_PREVIEW_ENTRIES) as ReadonlyArray<PreviewSelectableEntry>)
    : EMPTY_PREVIEW_ENTRIES;
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
    if (snapshot?.status === "starting" || scopeQuery.isPending || scopeQuery.isFetching) {
      return "Loading thread preview scope…";
    }
    if (scopeQuery.error instanceof Error) {
      return "Preview scope failed to load. See the session error details below.";
    }
    if (snapshot?.status === "ready" && scopeEntries.length === 0) {
      return "Previews appear from files changed in this thread and directly connected components.";
    }
    return null;
  }, [
    availability.reason,
    availability.supported,
    openError,
    scopeEntries.length,
    scopeQuery.error,
    scopeQuery.isFetching,
    scopeQuery.isPending,
    snapshot?.error?.message,
    snapshot?.status,
  ]);
  const changedScopedEntries = useMemo(
    () => scopeEntries.filter((entry) => isChangedScopedEntry(entry)),
    [scopeEntries],
  );
  const connectedScopedEntries = useMemo(
    () => scopeEntries.filter((entry) => !isChangedScopedEntry(entry)),
    [scopeEntries],
  );
  const autoPreviewId = changedScopedEntries[0]?.id ?? connectedScopedEntries[0]?.id ?? null;
  const selectedPreviewId = threadPreviewState?.selectedPreviewId ?? null;
  const isPinned = threadPreviewState?.pinned ?? false;
  const viewportMode = threadPreviewState?.viewportMode ?? "auto";
  const changedPreviewIds = useMemo(
    () => new Set(changedScopedEntries.map((entry) => entry.id)),
    [changedScopedEntries],
  );

  useEffect(() => {
    const nextEntries = [...scopeEntries, ...broaderEntries];
    if (nextEntries.length === 0) {
      return;
    }
    setKnownEntriesById((current) => {
      const next = { ...current };
      let changed = false;
      for (const entry of nextEntries) {
        if (current[entry.id] !== entry) {
          next[entry.id] = entry;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [broaderEntries, scopeEntries]);

  const availableEntries = useMemo(() => {
    const merged = new Map<string, PreviewSelectableEntry>();
    for (const entry of scopeEntries) {
      merged.set(entry.id, entry);
    }
    for (const entry of broaderEntries) {
      if (!merged.has(entry.id)) {
        merged.set(entry.id, entry);
      }
    }
    return [...merged.values()];
  }, [broaderEntries, scopeEntries]);

  const selectedPreview = useMemo(() => {
    if (!selectedPreviewId) {
      return null;
    }
    return (
      availableEntries.find((entry) => entry.id === selectedPreviewId) ??
      knownEntriesById[selectedPreviewId] ??
      null
    );
  }, [availableEntries, knownEntriesById, selectedPreviewId]);
  const selectedPreviewExistsInBroader = useMemo(
    () =>
      selectedPreviewId !== null && broaderEntries.some((entry) => entry.id === selectedPreviewId),
    [broaderEntries, selectedPreviewId],
  );

  const generationQueryKey = useMemo(
    () => [
      "previewGeneration",
      threadId,
      selectedPreview?.id ?? null,
      selectedPreview?.sourceHash ?? null,
      snapshot?.status === "ready" ? (snapshot.startedAt ?? snapshot.updatedAt) : null,
    ],
    [
      selectedPreview?.id,
      selectedPreview?.sourceHash,
      snapshot?.startedAt,
      snapshot?.status,
      snapshot?.updatedAt,
      threadId,
    ],
  );

  const generationQuery = useQuery({
    queryKey: generationQueryKey,
    queryFn: () => generatePreview(environmentId, threadId, selectedPreview!.id),
    enabled: snapshot?.status === "ready" && !!selectedPreview,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });

  const generatedPreview =
    selectedPreview && generationQuery.isFetching ? null : (generationQuery.data ?? null);
  const selectedCaseId =
    selectedPreview &&
    (threadPreviewState?.selectedCaseByPreviewId[selectedPreview.id] ??
      generatedPreview?.defaultCaseId ??
      "default");
  const selectedCase =
    generatedPreview?.cases.find((caseEntry) => caseEntry.id === selectedCaseId) ?? null;
  const selectedControlValues = useMemo(
    () =>
      selectedPreview
        ? mergeControlValuesForGeneration({
            generation: generatedPreview,
            currentValues: threadPreviewState?.selectedControlValuesByPreviewId[selectedPreview.id],
          })
        : EMPTY_CONTROL_VALUES,
    [generatedPreview, selectedPreview, threadPreviewState?.selectedControlValuesByPreviewId],
  );
  const viewportWidth = resolveViewportWidth(viewportMode, selectedCase?.viewport);
  const scopeEntriesSignature = useMemo(
    () =>
      scopeEntries
        .map((entry) => `${entry.id}:${entry.relationship}:${entry.distance}:${entry.sourceHash}`)
        .join("\u0000"),
    [scopeEntries],
  );
  const lastAppliedScopeSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    lastAppliedScopeSignatureRef.current = null;
  }, [threadKey]);

  useEffect(() => {
    if (isPinned) {
      lastAppliedScopeSignatureRef.current = scopeEntriesSignature;
      return;
    }

    if (scopeEntries.length === 0) {
      lastAppliedScopeSignatureRef.current = scopeEntriesSignature;
      if (selectedPreviewId !== null && !selectedPreviewExistsInBroader) {
        setSelectedPreview(threadKey, null);
      }
      return;
    }

    if (selectedPreviewExistsInBroader) {
      if (
        lastAppliedScopeSignatureRef.current !== scopeEntriesSignature &&
        autoPreviewId &&
        autoPreviewId !== selectedPreviewId
      ) {
        lastAppliedScopeSignatureRef.current = scopeEntriesSignature;
        setSelectedPreview(threadKey, autoPreviewId);
        return;
      }
      lastAppliedScopeSignatureRef.current = scopeEntriesSignature;
      return;
    }

    const previewExistsInScope =
      selectedPreviewId !== null && scopeEntries.some((entry) => entry.id === selectedPreviewId);
    if (!previewExistsInScope) {
      lastAppliedScopeSignatureRef.current = scopeEntriesSignature;
      setSelectedPreview(threadKey, autoPreviewId ?? scopeEntries[0]!.id);
      return;
    }

    if (
      lastAppliedScopeSignatureRef.current !== scopeEntriesSignature &&
      autoPreviewId &&
      autoPreviewId !== selectedPreviewId
    ) {
      lastAppliedScopeSignatureRef.current = scopeEntriesSignature;
      setSelectedPreview(threadKey, autoPreviewId);
      return;
    }

    lastAppliedScopeSignatureRef.current = scopeEntriesSignature;
  }, [
    autoPreviewId,
    isPinned,
    scopeEntries,
    scopeEntriesSignature,
    selectedPreviewId,
    selectedPreviewExistsInBroader,
    setSelectedPreview,
    threadKey,
  ]);

  useEffect(() => {
    if (selectedPreview) {
      return;
    }
    setVisiblePreviewTarget(null);
    setFrameLoadingState(null);
  }, [selectedPreview, setVisiblePreviewTarget]);

  useEffect(() => {
    if (!selectedPreview || !selectedCaseId || !generatedPreview) {
      return;
    }

    const caseExists = generatedPreview.cases.some((caseEntry) => caseEntry.id === selectedCaseId);
    if (!caseExists) {
      setSelectedCase(threadKey, selectedPreview.id, generatedPreview.defaultCaseId ?? "default");
    }
  }, [generatedPreview, selectedCaseId, selectedPreview, setSelectedCase, threadKey]);

  useEffect(() => {
    if (!selectedPreview || !generatedPreview) {
      return;
    }
    const persistedValues =
      threadPreviewState?.selectedControlValuesByPreviewId[selectedPreview.id] ?? null;
    if (persistedValues) {
      return;
    }
    const defaultControlValues = defaultControlValuesForGeneration(generatedPreview);
    if (Object.keys(defaultControlValues).length === 0) {
      return;
    }
    setControlValues(threadKey, selectedPreview.id, defaultControlValues);
  }, [
    generatedPreview,
    selectedPreview,
    setControlValues,
    threadKey,
    threadPreviewState?.selectedControlValuesByPreviewId,
  ]);

  useEffect(() => {
    if (
      !snapshot?.baseUrl ||
      !selectedPreview ||
      !selectedCaseId ||
      generationQuery.isFetching ||
      generatedPreview?.status !== "ready" ||
      !generatedPreview.renderToken
    ) {
      return;
    }

    const nextTarget = createIframeTarget({
      baseUrl: snapshot.baseUrl,
      previewId: selectedPreview.id,
      renderToken: generatedPreview.renderToken,
      caseId: selectedCaseId,
      theme: resolvedTheme,
      viewportWidth,
    });

    if (!visibleTarget) {
      setVisiblePreviewTarget(nextTarget);
      setFrameLoadingState({
        token: nextTarget.token,
        label: selectedPreview.label,
      });
      setPanelError(null);
      setCaseError(null);
      return;
    }

    if (
      visibleTarget.previewId === nextTarget.previewId &&
      visibleTarget.renderToken === nextTarget.renderToken &&
      visibleTarget.theme === nextTarget.theme
    ) {
      return;
    }

    setVisiblePreviewTarget(nextTarget);
    setFrameLoadingState({
      token: nextTarget.token,
      label: selectedPreview.label,
    });
    setPanelError(null);
    setCaseError(null);
  }, [
    resolvedTheme,
    selectedCaseId,
    generatedPreview?.renderToken,
    generatedPreview?.status,
    generationQuery.isFetching,
    selectedPreview,
    setVisiblePreviewTarget,
    snapshot?.baseUrl,
    viewportWidth,
    visibleTarget,
  ]);

  useEffect(() => {
    if (!frameLoadingState || !visibleTarget || frameLoadingState.token !== visibleTarget.token) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setFrameLoadingState((current) => (current?.token === visibleTarget.token ? null : current));
      setPanelError(`Preview load timed out for ${frameLoadingState.label}.`);
    }, PROBE_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [frameLoadingState, visibleTarget]);

  const postVisibleRenderUpdate = useEffectEvent(() => {
    const target = visibleTargetRef.current;
    if (!target || !selectedPreview || !selectedCaseId) {
      return;
    }
    if (target.previewId !== selectedPreview.id) {
      return;
    }

    const controlMessage: PreviewRenderControlMessageValue = {
      source: "forma-preview-parent",
      type: "update",
      loadToken: target.token,
      renderToken: target.renderToken,
      caseId: selectedCaseId,
      viewportWidth,
      controlValues: selectedControlValues,
    };

    visibleIframeRef.current?.contentWindow?.postMessage(controlMessage, "*");
  });

  useEffect(() => {
    postVisibleRenderUpdate();
  }, [selectedCaseId, selectedControlValues, selectedPreview, viewportWidth, visibleTarget]);

  const handlePreviewMessage = useEffectEvent((event: MessageEvent<unknown>) => {
    let message: PreviewRenderMessageValue | null = null;
    try {
      message = Schema.decodeUnknownSync(PreviewRenderMessage)(event.data);
    } catch {
      return;
    }

    const visibleTargetValue = visibleTargetRef.current;
    if (visibleTargetValue && message.loadToken === visibleTargetValue.token) {
      if (message.type === "ready") {
        setFrameLoadingState((current) =>
          current?.token === visibleTargetValue.token ? null : current,
        );
        setPanelError(null);
        setCaseError(null);
      } else {
        setFrameLoadingState((current) =>
          current?.token === visibleTargetValue.token ? null : current,
        );
        if (
          selectedPreview &&
          visibleTargetValue.previewId === selectedPreview.id &&
          message.message.includes("Unknown generated preview token") &&
          !autoRecoveredRenderTokensRef.current.has(visibleTargetValue.renderToken)
        ) {
          autoRecoveredRenderTokensRef.current.add(visibleTargetValue.renderToken);
          setPanelError(`Refreshing ${selectedPreview.label}…`);
          const api = readEnvironmentApi(environmentId);
          if (!api) {
            setCaseError("Environment API is unavailable.");
            return;
          }
          void api.preview
            .regenerate({
              threadId,
              componentId: selectedPreview.id,
            })
            .then((nextSnapshot) => {
              queryClient.setQueryData(generationQueryKey, nextSnapshot);
              setPanelError(null);
              setCaseError(null);
            })
            .catch((error) => {
              setPanelError(
                error instanceof Error ? error.message : "Failed to refresh the component preview.",
              );
            });
          return;
        }
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

  const handleSelectPreview = (previewId: string) => {
    if (!availableEntries.some((entry) => entry.id === previewId) && !knownEntriesById[previewId]) {
      return;
    }
    setSelectedPreview(threadKey, previewId);
    setPanelError(null);
    setCaseError(null);
  };

  const handleSelectCase = (caseId: string | null) => {
    if (!selectedPreview || !caseId) {
      return;
    }
    setSelectedCase(threadKey, selectedPreview.id, caseId);
    setPanelError(null);
    setCaseError(null);
  };

  const handleControlValueChange = useCallback(
    (controlId: string, nextValue: string | number | boolean) => {
      if (!selectedPreview) {
        return;
      }
      setControlValues(threadKey, selectedPreview.id, {
        ...selectedControlValues,
        [controlId]: nextValue,
      });
      setCaseError(null);
    },
    [selectedControlValues, selectedPreview, setControlValues, threadKey],
  );

  const sessionError =
    openError ??
    (scopeQuery.error instanceof Error
      ? scopeQuery.error.message
      : catalogQuery.error instanceof Error
        ? catalogQuery.error.message
        : generationQuery.error instanceof Error
          ? generationQuery.error.message
          : null);
  const recentPreviewLogs =
    snapshot?.logs.slice(-4).map((entry) => `[${entry.level}] ${entry.message}`) ?? [];
  const searchQuery = allPreviewFilter.trim();
  const catalogEmptyState = (
    <div className="space-y-1.5 p-3 text-xs text-muted-foreground/70">
      {searchQuery.length > 0 && (scopeEntries.length > 0 || broaderEntries.length > 0) ? (
        <p>No components match this search.</p>
      ) : emptyManifestHint ? (
        <div className="space-y-2">
          <p>{emptyManifestHint}</p>
          {searchQuery.length === 0 && snapshot?.status === "ready" && scopeEntries.length === 0 ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void handleDiscoverInProject();
              }}
            >
              Discover in project
            </Button>
          ) : null}
        </div>
      ) : null}
      {searchQuery.length === 0 && snapshot?.workspaceRoot ? (
        <p className="font-mono text-[11px] break-all">workspace: {snapshot.workspaceRoot}</p>
      ) : null}
      {searchQuery.length === 0 && snapshot?.launchCwd ? (
        <p className="font-mono text-[11px] break-all">launch: {snapshot.launchCwd}</p>
      ) : null}
      {searchQuery.length === 0 && snapshot?.baseUrl ? (
        <p className="font-mono text-[11px] break-all">preview: {snapshot.baseUrl}</p>
      ) : null}
      {searchQuery.length === 0 &&
        recentPreviewLogs.map((line) => (
          <p key={line} className="font-mono text-[11px] break-all">
            {line}
          </p>
        ))}
    </div>
  );

  const treeSections = useMemo(() => {
    const sections: Array<{
      key: string;
      label: string;
      description?: string;
      entries: ReadonlyArray<PreviewSelectableEntry>;
    }> = [];
    if (changedScopedEntries.length > 0) {
      sections.push({
        key: "changed",
        label: "Changed In Thread",
        description: `${changedScopedEntries.length} previewable component${changedScopedEntries.length === 1 ? "" : "s"} touched in this thread`,
        entries: changedScopedEntries,
      });
    }
    if (connectedScopedEntries.length > 0) {
      sections.push({
        key: "connected",
        label: "Connected",
        description: "Direct imports, importers, and legacy previews connected to changed files",
        entries: connectedScopedEntries,
      });
    }
    if (broaderDiscoveryRequested) {
      sections.push({
        key: "broader",
        label: "Broader Discovery",
        description:
          catalogQuery.isPending || catalogQuery.isFetching
            ? "Scanning the project catalog…"
            : "Project-wide previewable components",
        entries: broaderEntries.filter(
          (entry) => !scopeEntries.some((scopedEntry) => scopedEntry.id === entry.id),
        ),
      });
    }
    return sections;
  }, [
    broaderDiscoveryRequested,
    broaderEntries,
    catalogQuery.isFetching,
    catalogQuery.isPending,
    changedScopedEntries,
    connectedScopedEntries,
    scopeEntries,
  ]);

  const handleDiscoverInProject = useEffectEvent(async () => {
    setBroaderDiscoveryRequested(true);
    if (broaderDiscoveryRequested) {
      await catalogQuery.refetch();
    }
  });

  const handleRestart = useEffectEvent(async () => {
    setIsRestarting(true);
    setPanelError("Restarting preview server…");
    setCaseError(null);
    setFrameLoadingState(null);
    setVisiblePreviewTarget(null);

    try {
      await restart();
      await scopeQuery.refetch();
      if (broaderDiscoveryRequested) {
        await catalogQuery.refetch();
      }
      setPanelError(null);
    } catch {
      // usePreviewSession / scopeQuery / catalogQuery already surface the error states.
    } finally {
      setIsRestarting(false);
    }
  });

  const handleSetupPreview = useEffectEvent(async () => {
    const api = readEnvironmentApi(environmentId);
    const workspaceRoot = snapshot?.workspaceRoot ?? worktreePath ?? projectCwd;
    if (!api || !workspaceRoot) {
      setPanelError("Workspace access is unavailable.");
      return;
    }

    setIsScaffoldingPreview(true);
    setPanelError("Creating starter preview config…");
    setCaseError(null);

    try {
      const scaffold = await buildPreviewSetupScaffold({
        api,
        workspaceRoot,
      });

      for (const write of scaffold.writes) {
        await api.projects.writeFile({
          cwd: workspaceRoot,
          relativePath: write.relativePath,
          contents: write.contents,
          expectedVersion: write.expectedVersion,
        });
      }

      toastManager.add({
        type: "success",
        title: "Preview setup created",
        description:
          scaffold.writes.length === 1
            ? scaffold.writes[0]!.relativePath
            : `${scaffold.writes.length} files updated`,
      });

      setPanelError(
        scaffold.notes.length > 0
          ? `Preview setup completed. ${scaffold.notes[0]}`
          : "Preview setup completed. Restarting preview…",
      );

      await restart();
      await scopeQuery.refetch();
      if (broaderDiscoveryRequested) {
        await catalogQuery.refetch();
      }

      setPanelError(
        scaffold.notes.length > 0 ? `Preview setup completed. ${scaffold.notes[0]}` : null,
      );
    } catch (error) {
      if ((error as { _tag?: string })._tag === "ProjectFileVersionConflictError") {
        setPanelError("forma.preview.ts already exists. Retrying preview startup…");
        try {
          await restart();
          await scopeQuery.refetch();
          if (broaderDiscoveryRequested) {
            await catalogQuery.refetch();
          }
          return;
        } catch (restartError) {
          setPanelError(normalizeProjectFileEditError(restartError));
          return;
        }
      }

      setPanelError(normalizeProjectFileEditError(error));
    } finally {
      setIsScaffoldingPreview(false);
    }
  });

  const handleRegenerate = useEffectEvent(async () => {
    if (!selectedPreview) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setPanelError("Environment API is unavailable.");
      return;
    }
    setPanelError(`Regenerating ${selectedPreview.label}…`);
    try {
      const nextSnapshot = await api.preview.regenerate({
        threadId,
        componentId: selectedPreview.id,
      });
      queryClient.setQueryData(generationQueryKey, nextSnapshot);
      setPanelError(null);
      setCaseError(null);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to regenerate component preview.",
      );
    }
  });

  const handleVisibleIframeLoad = useEffectEvent(() => {
    const target = visibleTargetRef.current;
    if (target) {
      setFrameLoadingState((current) => (current?.token === target.token ? null : current));
      setPanelError((current) =>
        current?.startsWith("Preview load timed out for ") ? null : current,
      );
    }
    postVisibleRenderUpdate();
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

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-r border-border/60 bg-muted/10">
          <div className="shrink-0 border-b border-border/60 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
                  Components
                </p>
                <p className="text-xs text-muted-foreground/75">
                  {changedScopedEntries.length > 0
                    ? `${changedScopedEntries.length} changed in thread`
                    : scopeEntries.length > 0
                      ? `${scopeEntries.length} in current scope`
                      : broaderDiscoveryRequested
                        ? `${broaderEntries.length} discovered in project`
                        : "Thread-first scope"}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void handleDiscoverInProject();
                }}
                disabled={
                  !availability.supported ||
                  snapshot?.status !== "ready" ||
                  (broaderDiscoveryRequested && catalogQuery.isFetching)
                }
              >
                {catalogQuery.isFetching ? <Spinner className="size-3.5" /> : null}
                Discover in project
              </Button>
            </div>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={allPreviewFilter}
                onChange={(event) => setAllPreviewFilter(event.target.value)}
                placeholder="Search components"
                className="h-8 pl-7"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <PreviewCatalogTree
              sections={treeSections}
              selectedPreviewId={selectedPreviewId}
              changedPreviewIds={changedPreviewIds}
              searchQuery={allPreviewFilter}
              resolvedTheme={resolvedTheme}
              emptyState={catalogEmptyState}
              onSelectPreview={handleSelectPreview}
            />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border/60">
            <div className="flex flex-wrap items-center gap-2 p-3">
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
                  value={selectedCaseId ?? generatedPreview?.defaultCaseId ?? "default"}
                  onValueChange={handleSelectCase}
                  disabled={!generatedPreview || generatedPreview.cases.length === 0}
                >
                  <SelectTrigger size="xs" className="w-44" aria-label="Preview case">
                    <SelectValue>
                      {selectedCase ? previewCaseLabel(selectedCase) : "Case"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {(generatedPreview?.cases ?? []).map((caseEntry) => (
                      <SelectItem key={caseEntry.id} value={caseEntry.id} hideIndicator>
                        {previewCaseLabel(caseEntry)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void handleRegenerate();
                }}
                disabled={!selectedPreview || generationQuery.isFetching}
              >
                {generationQuery.isFetching ? <Spinner className="size-3.5" /> : null}
                Regenerate
              </Button>
              {selectedPreview ? (
                <span className="truncate text-xs text-muted-foreground/70">
                  {selectedPreview.label}
                </span>
              ) : null}
            </div>

            {generatedPreview?.controls.length ? (
              <div className="grid gap-2 border-t border-border/40 p-3 md:grid-cols-2 xl:grid-cols-3">
                {generatedPreview.controls.map((control) => {
                  const value = selectedControlValues[control.id] ?? control.defaultValue;
                  return (
                    <div
                      key={control.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/60 px-2.5 py-2"
                    >
                      <span className="text-xs text-muted-foreground">{controlLabel(control)}</span>
                      {control.kind === "boolean" ? (
                        <Switch
                          checked={value === true}
                          onCheckedChange={(checked) =>
                            handleControlValueChange(control.id, checked)
                          }
                        />
                      ) : control.kind === "enum" ? (
                        <Select
                          value={
                            typeof value === "string" ? value : String(control.defaultValue ?? "")
                          }
                          onValueChange={(nextValue) => {
                            if (nextValue !== null) {
                              handleControlValueChange(control.id, nextValue);
                            }
                          }}
                        >
                          <SelectTrigger size="xs" className="w-36" aria-label={control.label}>
                            <SelectValue>
                              {typeof value === "string" ? value : control.label}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            {(control.options ?? []).map((option) => (
                              <SelectItem key={option.value} value={option.value} hideIndicator>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      ) : (
                        <Input
                          value={value === undefined ? "" : String(value)}
                          onChange={(event) =>
                            handleControlValueChange(
                              control.id,
                              control.kind === "number"
                                ? Number.parseInt(event.target.value || "0", 10) || 0
                                : event.target.value,
                            )
                          }
                          className="h-8 w-40"
                          inputMode={control.kind === "number" ? "numeric" : undefined}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {generatedPreview?.warnings.length ? (
              <div className="space-y-1.5 border-t border-border/40 p-3">
                <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
                  Preview warnings
                </p>
                <div className="space-y-1">
                  {generatedPreview.warnings.map((warning) => (
                    <div
                      key={`${warning.code}:${warning.message}`}
                      className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-100"
                    >
                      {warning.message}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
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
            {generatedPreview?.status === "error" ? (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100">
                {generatedPreview.message ?? "Preview generation failed."}
              </div>
            ) : null}

            {snapshot?.status === "unsupported" ? (
              <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
                <p>
                  {snapshot.error?.message ??
                    "No forma.preview.ts file was found for this workspace."}
                </p>
                {snapshot.error?.reason === "missing-config" && availability.supported ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground/80">
                      Set up preview creates a starter <code>forma.preview.ts</code> in this
                      workspace so preview can be configured per project instead of assumed.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          void handleSetupPreview();
                        }}
                        disabled={isScaffoldingPreview || projectCwd === null}
                      >
                        {isScaffoldingPreview ? <Spinner className="size-3.5" /> : null}
                        Set up preview
                      </Button>
                    </div>
                  </div>
                ) : null}
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

            <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
              {snapshot?.status === "starting" && !visibleTarget ? (
                <div className="flex h-full min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Starting preview server…
                </div>
              ) : null}
              {generationQuery.isPending && !visibleTarget && selectedPreview ? (
                <div className="flex h-full min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Generating component preview…
                </div>
              ) : null}

              {visibleTarget ? (
                <iframe
                  ref={visibleIframeRef}
                  title="Component preview"
                  src={visibleTarget.src}
                  onLoad={() => {
                    handleVisibleIframeLoad();
                  }}
                  // The preview server runs on a different loopback port than Forma,
                  // so same-origin here restores module/runtime behavior without
                  // giving the iframe access to the parent document.
                  // eslint-disable-next-line react/iframe-missing-sandbox
                  sandbox="allow-scripts allow-same-origin"
                  className="block h-full min-h-full w-full border-0 bg-transparent"
                />
              ) : null}

              {(generationQuery.isPending ||
                (generationQuery.isFetching &&
                  (!visibleTarget || visibleTarget.previewId !== selectedPreview?.id))) &&
              selectedPreview ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/65 backdrop-blur-[1px]">
                  <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/90 px-3 py-2 text-sm text-muted-foreground shadow-sm">
                    <Spinner className="size-4" />
                    Generating {selectedPreview.label}…
                  </div>
                </div>
              ) : null}

              {frameLoadingState ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/45">
                  <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/90 px-3 py-2 text-sm text-muted-foreground shadow-sm">
                    <Spinner className="size-4" />
                    Loading {frameLoadingState.label}…
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
});
