import { scopedProjectKey, scopeThreadRef } from "@forma/client-runtime";
import type {
  ModelSelection,
  OrchestrationThreadShell,
  ProjectPreviewWorkspaceRecord,
  ScopedProjectRef,
  ThreadId,
} from "@forma/contracts";
import { DEFAULT_MODEL_BY_PROVIDER } from "@forma/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  IconArrowClockwise as RefreshIcon,
  IconChevronDown as ChevronDownIcon,
  IconChevronUp as ChevronUpIcon,
  IconRectangleOnRectangle as PreviewIcon,
  IconSparkles,
  IconXmark as XIcon,
} from "symbols-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../environmentApi";
import { useBottomDrawerSizing } from "../bottomDrawerSizing";
import { useBottomDrawerUiStore } from "../bottomDrawerUiStore";
import { stageOptimisticThreadShell } from "../environments/runtime/service";
import { getEnvironmentHttpBaseUrl, resolveEnvironmentHttpUrl } from "../environments/runtime";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import {
  type PreviewControlDescriptor,
  type PreviewRuntimeSnapshot,
  usePreviewWorkspaceStore,
} from "../previewWorkspaceStore";
import {
  buildSessionFromRuntimeSnapshot,
  getPreviewFileSession,
  mergePreviewControlsWithDrafts,
  normalizeSelectedScenarioId,
  upsertPreviewFileSession,
} from "../previewSessionState";
import { selectProjectsAcrossEnvironments, selectThreadByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import type { Project } from "../types";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

function resolvePreviewUrl(
  projectRef: ScopedProjectRef,
  iframePath: string,
  accessToken: string,
): string {
  const [rawPathname = "/", search = ""] = iframePath.split("?");
  const searchParams = new URLSearchParams(search);
  searchParams.set("previewToken", accessToken);
  return resolveEnvironmentHttpUrl({
    environmentId: projectRef.environmentId,
    pathname: rawPathname,
    searchParams: Object.fromEntries(searchParams),
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return (
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "localhost"
  );
}

function workspaceLabel(workspaceRootRelativePath: string): string {
  return workspaceRootRelativePath.trim().length > 0 ? workspaceRootRelativePath : "project root";
}

function buildPreviewSetupThreadTitle(workspaceRootRelativePath: string): string {
  return `Preview setup · ${workspaceLabel(workspaceRootRelativePath)}`;
}

function buildOptimisticPreviewThreadShell(input: {
  threadId: ThreadId;
  projectId: Project["id"];
  title: string;
  modelSelection: ModelSelection;
  createdAt: string;
}): OrchestrationThreadShell {
  return {
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    queuedTurnCount: 0,
    turnQueueStatus: "idle",
  };
}

function resolvePreviewThreadModelSelection(project: Project): ModelSelection {
  return (
    project.defaultModelSelection ?? {
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    }
  );
}

function upsertPreviewWorkspaceRecord(
  existingRecords: readonly ProjectPreviewWorkspaceRecord[] | undefined,
  nextRecord: ProjectPreviewWorkspaceRecord,
): ProjectPreviewWorkspaceRecord[] {
  const remaining = (existingRecords ?? []).filter(
    (record) => record.workspaceRootRelativePath !== nextRecord.workspaceRootRelativePath,
  );
  return [...remaining, nextRecord].toSorted((left, right) =>
    left.workspaceRootRelativePath.localeCompare(right.workspaceRootRelativePath),
  );
}

type PreviewParentCommandMessage =
  | {
      source: "forma-preview-parent";
      kind: "preview.command.restoreSession";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      commandId: number;
      selectedScenarioId: string | null;
      argOverrides: Record<string, unknown>;
    }
  | {
      source: "forma-preview-parent";
      kind: "preview.command.selectScenario";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      commandId: number;
      scenarioId: string;
    }
  | {
      source: "forma-preview-parent";
      kind: "preview.command.setArgsPartial";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      commandId: number;
      argsPartial: Record<string, unknown>;
    };

interface PreviewRuntimeSnapshotMessage {
  source: "forma-component-harness";
  runtimeInstanceId: string;
  previewFileRelativePath: string;
  scenarioChoices: Array<{ id: string; name: string }>;
  currentScenarioId: string | null;
  controls: PreviewControlDescriptor[];
  argOverrides: Record<string, unknown>;
  lastAppliedCommandId: number;
}

interface PreviewReadyMessage extends PreviewRuntimeSnapshotMessage {
  kind: "preview.ready";
}

interface PreviewStateMessage extends PreviewRuntimeSnapshotMessage {
  kind: "preview.state";
}

interface PreviewRuntimeErrorMessage {
  source: "forma-component-harness";
  kind: "preview.runtime.error";
  runtimeInstanceId: string;
  previewFileRelativePath: string;
  message: string;
}

function buildRuntimeSnapshotFromMessage(
  message: PreviewReadyMessage | PreviewStateMessage,
): PreviewRuntimeSnapshot {
  return {
    runtimeInstanceId: message.runtimeInstanceId,
    currentScenarioId: message.currentScenarioId,
    currentScenarioChoices: [...message.scenarioChoices],
    controls: [...message.controls],
    lastAppliedCommandId: message.lastAppliedCommandId,
  };
}

function PreviewControlsContent(props: {
  scenarioItems: readonly { value: string; label: string }[];
  selectedScenarioId: string | null;
  controls: readonly PreviewControlDescriptor[];
  onSelectScenario: (scenarioId: string) => void;
  onSetControlValue: (name: string, value: unknown, mode: "debounced" | "immediate") => void;
  onFlushControl: (name: string) => void;
}) {
  return (
    <div className="w-72 space-y-4">
      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
          Controls
        </div>
        {props.scenarioItems.length > 0 ? (
          <div className="mt-4 flex flex-col gap-2 text-sm">
            <span className="font-medium text-foreground">Variant</span>
            <Select
              items={props.scenarioItems}
              value={props.selectedScenarioId ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  props.onSelectScenario(value);
                }
              }}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {props.scenarioItems.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value} hideIndicator>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
      </div>

      {props.controls.length === 0 ? (
        <div className="rounded-lg border border-border/70 bg-background/80 p-3 text-sm text-muted-foreground">
          No interactive controls are available for this preview.
        </div>
      ) : (
        <div className="space-y-4">
          {props.controls.map((control) => {
            const inputId = `preview-control-${control.name}`;
            if (control.type === "boolean") {
              return (
                <label
                  key={control.name}
                  htmlFor={inputId}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">{control.label}</span>
                    {control.description ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {control.description}
                      </span>
                    ) : null}
                  </span>
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={Boolean(control.value)}
                    onChange={(event) =>
                      props.onSetControlValue(
                        control.name,
                        event.currentTarget.checked,
                        "immediate",
                      )
                    }
                  />
                </label>
              );
            }

            if (
              control.type === "select" ||
              control.type === "radio" ||
              control.type === "inline-radio"
            ) {
              const selectItems = (control.options ?? []).map((option) => {
                const optionValue = String(option);
                return {
                  value: optionValue,
                  label: optionValue,
                };
              });
              return (
                <div key={control.name} className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-foreground">{control.label}</span>
                  <Select
                    items={selectItems}
                    value={typeof control.value === "string" ? control.value : ""}
                    onValueChange={(value) => {
                      if (typeof value !== "string") {
                        return;
                      }
                      props.onSetControlValue(control.name, value, "immediate");
                    }}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {selectItems.map((item) => (
                        <SelectItem key={item.value} value={item.value} hideIndicator>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              );
            }

            if (
              control.type === "multi-select" ||
              control.type === "check" ||
              control.type === "inline-check"
            ) {
              const currentValues = Array.isArray(control.value) ? control.value.map(String) : [];
              return (
                <div key={control.name} className="space-y-2 text-sm">
                  <div className="font-medium text-foreground">{control.label}</div>
                  <div className="space-y-2">
                    {(control.options ?? []).map((option) => {
                      const stringValue = String(option);
                      const checked = currentValues.includes(stringValue);
                      return (
                        <label
                          key={stringValue}
                          className="flex items-center gap-2 text-muted-foreground"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const nextValues = new Set(currentValues);
                              if (event.currentTarget.checked) {
                                nextValues.add(stringValue);
                              } else {
                                nextValues.delete(stringValue);
                              }
                              props.onSetControlValue(control.name, [...nextValues], "immediate");
                            }}
                          />
                          {stringValue}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            }

            if (control.type === "object") {
              return (
                <label key={control.name} className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-foreground">{control.label}</span>
                  <textarea
                    className="min-h-28 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                    defaultValue={JSON.stringify(control.value ?? null, null, 2)}
                    onBlur={(event) => {
                      try {
                        props.onSetControlValue(
                          control.name,
                          JSON.parse(event.currentTarget.value),
                          "immediate",
                        );
                      } catch {
                        event.currentTarget.value = JSON.stringify(control.value ?? null, null, 2);
                      }
                    }}
                  />
                </label>
              );
            }

            const inputType =
              control.type === "color"
                ? "color"
                : control.type === "date"
                  ? "date"
                  : control.type === "range"
                    ? "range"
                    : control.type === "number"
                      ? "number"
                      : "text";
            return (
              <label key={control.name} className="flex flex-col gap-2 text-sm">
                <span className="font-medium text-foreground">{control.label}</span>
                <input
                  id={inputId}
                  type={inputType}
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={
                    typeof control.value === "string" || typeof control.value === "number"
                      ? String(control.value)
                      : ""
                  }
                  min={control.min ?? undefined}
                  max={control.max ?? undefined}
                  step={control.step ?? undefined}
                  onChange={(event) => {
                    const nextValue =
                      control.type === "number" || control.type === "range"
                        ? event.currentTarget.value === ""
                          ? ""
                          : Number(event.currentTarget.value)
                        : event.currentTarget.value;
                    props.onSetControlValue(control.name, nextValue, "debounced");
                  }}
                  onBlur={() => props.onFlushControl(control.name)}
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PreviewDrawer() {
  const navigate = useNavigate();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const sharedHeight = useBottomDrawerUiStore((state) => state.sharedHeight);
  const setSharedHeight = useBottomDrawerUiStore((state) => state.setSharedHeight);
  const fullHeight = useBottomDrawerUiStore((state) => state.isFullHeight);
  const setFullHeight = useBottomDrawerUiStore((state) => state.setFullHeight);
  const closePreviewDrawer = useBottomDrawerUiStore((state) => state.closeVisibleMode);
  const activeRouteThread = useStore(
    useMemo(
      () =>
        routeTarget?.kind === "server"
          ? createThreadSelectorByRef(routeTarget.threadRef)
          : () => undefined,
      [routeTarget],
    ),
  );
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const { activeProjectRef, patchProjectState, projectStateByKey, updateProjectState } =
    usePreviewWorkspaceStore(
      useShallow((state) => ({
        activeProjectRef: state.activeProjectRef,
        patchProjectState: state.patchProjectState,
        updateProjectState: state.updateProjectState,
        projectStateByKey: state.projectStateByKey,
      })),
    );
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [launchingAction, setLaunchingAction] = useState<
    "bootstrap" | "generation" | "repair" | null
  >(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const handledPreviewTurnKeyRef = useRef<string | null>(null);
  const nextPreviewCommandIdRef = useRef(1);
  const runtimeCommandWatermarkRef = useRef<Record<string, number>>({});
  const pendingArgsPartialsRef = useRef<Record<string, Record<string, unknown>>>({});
  const pendingArgsTimerRef = useRef<Record<string, number>>({});
  const previousPreviewFileRelativePathRef = useRef<string | null>(null);
  const {
    drawerRef,
    drawerHeight,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerEnd,
  } = useBottomDrawerSizing<HTMLDivElement>({
    visible: true,
    height: sharedHeight,
    fullHeight,
    onHeightChange: setSharedHeight,
    onFullHeightChange: setFullHeight,
    identityKey: activeProjectRef
      ? `${activeProjectRef.environmentId}:${activeProjectRef.projectId}`
      : "preview",
  });

  const activeProject = useMemo(
    () =>
      activeProjectRef
        ? (projects.find(
            (project) =>
              project.environmentId === activeProjectRef.environmentId &&
              project.id === activeProjectRef.projectId,
          ) ?? null)
        : null,
    [activeProjectRef, projects],
  );
  const activeProjectState =
    activeProjectRef &&
    projectStateByKey[`${activeProjectRef.environmentId}:${activeProjectRef.projectId}`]
      ? projectStateByKey[`${activeProjectRef.environmentId}:${activeProjectRef.projectId}`]!
      : null;
  const activeRouteLatestTurn = activeRouteThread?.latestTurn ?? null;
  const api = activeProjectRef ? readEnvironmentApi(activeProjectRef.environmentId) : undefined;
  const currentRuntimeErrorMessage =
    activeProjectState?.resolution?.status === "runtimeError"
      ? activeProjectState.resolution.message
      : activeProjectState?.runtimeState?.kind === "runtime.error"
        ? activeProjectState.runtimeState.message
        : null;
  const currentRuntimeErrorPreviewFileRelativePath =
    activeProjectState?.resolution?.status === "runtimeError"
      ? activeProjectState.resolution.previewFileRelativePath
      : (activeProjectState?.currentPreviewFileRelativePath ?? null);
  const resolved =
    activeProjectState?.resolution?.status === "resolved" ? activeProjectState.resolution : null;
  const activePreviewFileRelativePath =
    activeProjectState?.currentPreviewFileRelativePath ?? resolved?.previewFileRelativePath ?? null;
  const activePreviewSession = getPreviewFileSession(
    activeProjectState?.sessionsByPreviewFilePath ?? {},
    activePreviewFileRelativePath,
  );
  const runtimeSnapshot = activeProjectState?.runtimeSnapshot ?? null;
  const scenarioChoices = runtimeSnapshot?.currentScenarioChoices ?? [];
  const scenarioItems = useMemo(
    () =>
      scenarioChoices.map((choice) => ({
        value: choice.id,
        label: choice.name,
      })),
    [scenarioChoices],
  );
  const selectedScenarioId =
    activePreviewSession?.selectedScenarioId ??
    runtimeSnapshot?.currentScenarioId ??
    resolved?.initialScenarioId ??
    null;
  const displayedControls = useMemo(
    () =>
      mergePreviewControlsWithDrafts(
        runtimeSnapshot?.controls ?? [],
        activePreviewSession?.draftArgOverrides ?? {},
      ),
    [activePreviewSession?.draftArgOverrides, runtimeSnapshot?.controls],
  );
  const environmentHttpBaseUrl = activeProjectRef
    ? getEnvironmentHttpBaseUrl(activeProjectRef.environmentId)
    : null;
  const shouldUseDirectIframe =
    Boolean(resolved?.directIframeUrl) &&
    Boolean(environmentHttpBaseUrl) &&
    (() => {
      if (!environmentHttpBaseUrl) {
        return false;
      }
      try {
        return isLoopbackHostname(new URL(environmentHttpBaseUrl).hostname);
      } catch {
        return false;
      }
    })();
  const iframeUrl =
    activeProjectRef && resolved
      ? shouldUseDirectIframe && resolved.directIframeUrl
        ? resolved.directIframeUrl
        : activeProjectState?.accessToken
          ? resolvePreviewUrl(activeProjectRef, resolved.iframePath, activeProjectState.accessToken)
          : null
      : null;

  const postPreviewCommand = useCallback((message: PreviewParentCommandMessage) => {
    const contentWindow = iframeRef.current?.contentWindow;
    if (!contentWindow) {
      return null;
    }
    runtimeCommandWatermarkRef.current[message.runtimeInstanceId] = message.commandId;
    contentWindow.postMessage(message, "*");
    return message.commandId;
  }, []);

  const refreshInspection = async () => {
    if (!activeProjectRef || !api || !activeProject) {
      return;
    }
    const result = await api.preview.inspectProject({
      projectId: activeProjectRef.projectId,
      cwd: activeProject.cwd,
    });
    patchProjectState(activeProjectRef, {
      inspection: result,
    });
  };

  const clearPendingArgsForPreviewFile = useCallback((previewFileRelativePath: string | null) => {
    if (!previewFileRelativePath) {
      return;
    }
    const timerId = pendingArgsTimerRef.current[previewFileRelativePath];
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      delete pendingArgsTimerRef.current[previewFileRelativePath];
    }
    delete pendingArgsPartialsRef.current[previewFileRelativePath];
  }, []);

  const sendPreviewCommandForActiveRuntime = useCallback(
    (
      input:
        | {
            kind: "preview.command.restoreSession";
            runtimeInstanceId: string;
            previewFileRelativePath: string;
            selectedScenarioId: string | null;
            argOverrides: Record<string, unknown>;
          }
        | {
            kind: "preview.command.selectScenario";
            runtimeInstanceId: string;
            previewFileRelativePath: string;
            scenarioId: string;
          }
        | {
            kind: "preview.command.setArgsPartial";
            runtimeInstanceId: string;
            previewFileRelativePath: string;
            argsPartial: Record<string, unknown>;
          },
    ) => {
      const commandId = nextPreviewCommandIdRef.current++;
      if (input.kind === "preview.command.restoreSession") {
        return postPreviewCommand({
          source: "forma-preview-parent",
          kind: input.kind,
          runtimeInstanceId: input.runtimeInstanceId,
          previewFileRelativePath: input.previewFileRelativePath,
          commandId,
          selectedScenarioId: input.selectedScenarioId,
          argOverrides: input.argOverrides,
        });
      }
      if (input.kind === "preview.command.selectScenario") {
        return postPreviewCommand({
          source: "forma-preview-parent",
          kind: input.kind,
          runtimeInstanceId: input.runtimeInstanceId,
          previewFileRelativePath: input.previewFileRelativePath,
          commandId,
          scenarioId: input.scenarioId,
        });
      }
      return postPreviewCommand({
        source: "forma-preview-parent",
        kind: input.kind,
        runtimeInstanceId: input.runtimeInstanceId,
        previewFileRelativePath: input.previewFileRelativePath,
        commandId,
        argsPartial: input.argsPartial,
      });
    },
    [postPreviewCommand],
  );

  const flushPendingArgsForPreviewFile = useCallback(
    (previewFileRelativePath: string | null) => {
      if (!previewFileRelativePath || !activeProjectRef) {
        return;
      }

      const pendingPartialArgs = pendingArgsPartialsRef.current[previewFileRelativePath];
      clearPendingArgsForPreviewFile(previewFileRelativePath);
      if (!pendingPartialArgs || Object.keys(pendingPartialArgs).length === 0) {
        return;
      }

      const projectState =
        usePreviewWorkspaceStore.getState().projectStateByKey[scopedProjectKey(activeProjectRef)] ??
        null;
      const runtimeInstanceId = projectState?.runtimeSnapshot?.runtimeInstanceId ?? null;
      const activePreviewFilePath = projectState?.currentPreviewFileRelativePath ?? null;
      if (!runtimeInstanceId || activePreviewFilePath !== previewFileRelativePath) {
        return;
      }

      void sendPreviewCommandForActiveRuntime({
        kind: "preview.command.setArgsPartial",
        runtimeInstanceId,
        previewFileRelativePath,
        argsPartial: pendingPartialArgs,
      });
    },
    [activeProjectRef, clearPendingArgsForPreviewFile, sendPreviewCommandForActiveRuntime],
  );

  const queuePendingArgsPartial = useCallback(
    (previewFileRelativePath: string, argsPartial: Record<string, unknown>, immediate: boolean) => {
      pendingArgsPartialsRef.current[previewFileRelativePath] = {
        ...(pendingArgsPartialsRef.current[previewFileRelativePath] ?? {}),
        ...argsPartial,
      };

      if (immediate) {
        flushPendingArgsForPreviewFile(previewFileRelativePath);
        return;
      }

      const existingTimerId = pendingArgsTimerRef.current[previewFileRelativePath];
      if (existingTimerId !== undefined) {
        window.clearTimeout(existingTimerId);
      }
      pendingArgsTimerRef.current[previewFileRelativePath] = window.setTimeout(() => {
        flushPendingArgsForPreviewFile(previewFileRelativePath);
      }, 150);
    },
    [flushPendingArgsForPreviewFile],
  );

  const applyRuntimeSnapshot = useCallback(
    (
      message: PreviewReadyMessage | PreviewStateMessage,
      confirmedArgOverrides: Record<string, unknown>,
    ) => {
      if (!activeProjectRef) {
        return;
      }
      updateProjectState(activeProjectRef, (state) => {
        if (
          state.currentPreviewFileRelativePath &&
          state.currentPreviewFileRelativePath !== message.previewFileRelativePath
        ) {
          return state;
        }
        const runtimeSnapshot = buildRuntimeSnapshotFromMessage(message);
        const existingSession = getPreviewFileSession(
          state.sessionsByPreviewFilePath,
          message.previewFileRelativePath,
        );
        return {
          ...state,
          currentPreviewFileRelativePath: message.previewFileRelativePath,
          runtimeSnapshot,
          sessionsByPreviewFilePath: upsertPreviewFileSession(
            state.sessionsByPreviewFilePath,
            message.previewFileRelativePath,
            () =>
              buildSessionFromRuntimeSnapshot({
                existingSession,
                previewFileRelativePath: message.previewFileRelativePath,
                runtimeSnapshot,
                confirmedArgOverrides,
              }),
          ),
        };
      });
    },
    [activeProjectRef, updateProjectState],
  );

  const restoreSessionIntoRuntime = useCallback(
    (message: PreviewReadyMessage) => {
      if (!activeProjectRef) {
        return;
      }
      const projectState =
        usePreviewWorkspaceStore.getState().projectStateByKey[scopedProjectKey(activeProjectRef)] ??
        null;
      const cachedSession = getPreviewFileSession(
        projectState?.sessionsByPreviewFilePath ?? {},
        message.previewFileRelativePath,
      );
      if (!cachedSession) {
        return;
      }

      const selectedScenarioId = normalizeSelectedScenarioId(
        cachedSession.selectedScenarioId,
        message.scenarioChoices,
        message.currentScenarioId,
      );
      const argOverrides = {
        ...cachedSession.confirmedArgOverrides,
        ...cachedSession.draftArgOverrides,
      };

      if (
        selectedScenarioId === message.currentScenarioId &&
        Object.keys(argOverrides).length === 0
      ) {
        return;
      }

      void sendPreviewCommandForActiveRuntime({
        kind: "preview.command.restoreSession",
        runtimeInstanceId: message.runtimeInstanceId,
        previewFileRelativePath: message.previewFileRelativePath,
        selectedScenarioId,
        argOverrides,
      });
    },
    [activeProjectRef, sendPreviewCommandForActiveRuntime],
  );

  const restartPreviewRuntime = async () => {
    if (!activeProjectRef || !api) {
      return;
    }
    clearPendingArgsForPreviewFile(activeProjectState?.currentPreviewFileRelativePath ?? null);
    patchProjectState(activeProjectRef, {
      runtimeState: {
        kind: "runtime.starting",
        projectId: activeProjectRef.projectId,
      },
      accessToken: null,
      runtimeSnapshot: null,
    });
    await api.preview.stopRuntime({
      projectId: activeProjectRef.projectId,
    });
  };

  const resolveCurrentTarget = async () => {
    if (!activeProjectRef || !api) {
      return;
    }
    const latestProjectState =
      usePreviewWorkspaceStore.getState().projectStateByKey[
        `${activeProjectRef.environmentId}:${activeProjectRef.projectId}`
      ];
    if (!latestProjectState?.currentRelativePath) {
      return;
    }

    try {
      const resolution = await api.preview.resolveTarget({
        projectId: activeProjectRef.projectId,
        relativePath: latestProjectState.currentRelativePath,
      });

      const previewFileRelativePath =
        resolution.status === "resolved"
          ? resolution.previewFileRelativePath
          : resolution.status === "needsGeneration" || resolution.status === "runtimeError"
            ? resolution.previewFileRelativePath
            : null;
      updateProjectState(activeProjectRef, (state) => {
        const shouldPreserveRuntimeSnapshot =
          resolution.status === "resolved" &&
          state.currentPreviewFileRelativePath === resolution.previewFileRelativePath;
        const nextSessionsByPreviewFilePath =
          resolution.status === "resolved" && resolution.previewFileRelativePath
            ? upsertPreviewFileSession(
                state.sessionsByPreviewFilePath,
                resolution.previewFileRelativePath,
                (existingSession) => ({
                  ...existingSession,
                  selectedScenarioId:
                    existingSession.selectedScenarioId ?? resolution.initialScenarioId ?? null,
                }),
              )
            : state.sessionsByPreviewFilePath;
        return {
          ...state,
          resolution,
          runtimeState: resolution.status === "resolved" ? state.runtimeState : null,
          currentPreviewFileRelativePath: previewFileRelativePath,
          runtimeSnapshot: shouldPreserveRuntimeSnapshot ? state.runtimeSnapshot : null,
          sessionsByPreviewFilePath: nextSessionsByPreviewFilePath,
        };
      });
    } catch (error) {
      patchProjectState(activeProjectRef, {
        resolution: null,
        runtimeSnapshot: null,
        runtimeState: {
          kind: "runtime.error",
          projectId: activeProjectRef.projectId,
          message: error instanceof Error ? error.message : "Failed to resolve preview target.",
        },
      });
    }
  };

  useEffect(() => {
    if (!activeProjectRef || !api) return;
    return api.preview.subscribeProject(
      { projectId: activeProjectRef.projectId },
      (event) => {
        patchProjectState(activeProjectRef, { runtimeState: event });
      },
      {
        onResubscribe: () => {
          patchProjectState(activeProjectRef, { runtimeState: null });
        },
      },
    );
  }, [activeProjectRef, api, patchProjectState]);

  useEffect(() => {
    void refreshInspection();
  }, [activeProjectRef?.environmentId, activeProjectRef?.projectId]);

  useEffect(() => {
    if (!activeProjectRef || !api || !activeProjectState?.currentRelativePath) {
      return;
    }
    void resolveCurrentTarget();
  }, [activeProjectRef, activeProjectState?.currentRelativePath, api]);

  useEffect(() => {
    setActionErrorMessage(null);
  }, [
    activeProjectRef?.environmentId,
    activeProjectRef?.projectId,
    activeProjectState?.currentRelativePath,
  ]);

  useEffect(() => {
    const previousPreviewFileRelativePath = previousPreviewFileRelativePathRef.current;
    if (
      previousPreviewFileRelativePath &&
      previousPreviewFileRelativePath !== activePreviewFileRelativePath
    ) {
      clearPendingArgsForPreviewFile(previousPreviewFileRelativePath);
    }
    previousPreviewFileRelativePathRef.current = activePreviewFileRelativePath;
  }, [activePreviewFileRelativePath, clearPendingArgsForPreviewFile]);

  useEffect(
    () => () => {
      for (const previewFileRelativePath of Object.keys(pendingArgsTimerRef.current)) {
        clearPendingArgsForPreviewFile(previewFileRelativePath);
      }
    },
    [clearPendingArgsForPreviewFile],
  );

  const persistWorkspaceThreadRecord = async (input: {
    workspaceRootRelativePath: string;
    threadId: ThreadId;
    status: ProjectPreviewWorkspaceRecord["status"];
    lastPreviewFileRelativePath: string | null;
    lastError: string | null;
  }) => {
    if (!activeProjectRef || !api) {
      return;
    }
    const latestProject =
      selectProjectsAcrossEnvironments(useStore.getState()).find(
        (project) =>
          project.environmentId === activeProjectRef.environmentId &&
          project.id === activeProjectRef.projectId,
      ) ?? null;
    if (!latestProject) {
      return;
    }
    const nextRecords = upsertPreviewWorkspaceRecord(latestProject.previewWorkspaceRecords, {
      workspaceRootRelativePath: input.workspaceRootRelativePath,
      threadId: input.threadId,
      status: input.status,
      lastPreviewFileRelativePath: input.lastPreviewFileRelativePath,
      lastError: input.lastError,
      updatedAt: new Date().toISOString(),
    });
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: newCommandId(),
      projectId: activeProjectRef.projectId,
      previewWorkspaceRecords: nextRecords,
    });
  };

  const persistWorkspaceThreadRecordBestEffort = async (input: {
    workspaceRootRelativePath: string;
    threadId: ThreadId;
    status: ProjectPreviewWorkspaceRecord["status"];
    lastPreviewFileRelativePath: string | null;
    lastError: string | null;
  }) => {
    try {
      await persistWorkspaceThreadRecord(input);
    } catch (error) {
      console.error("Failed to persist preview workspace record.", error);
    }
  };

  const resolveExistingPreviewThreadId = (threadId: ThreadId | null): ThreadId | null => {
    if (!activeProjectRef || !threadId) {
      return null;
    }
    const thread = selectThreadByRef(
      useStore.getState(),
      scopeThreadRef(activeProjectRef.environmentId, threadId),
    );
    return thread && thread.projectId === activeProjectRef.projectId ? threadId : null;
  };

  const navigateToPreviewThread = async (threadId: ThreadId) => {
    if (!activeProjectRef) {
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeProjectRef.environmentId, threadId)),
    });
  };

  const openOrResumePreviewThread = async (input: {
    workspaceRootRelativePath: string;
    existingThreadId: ThreadId | null;
    title: string;
    prompt: string;
    status: ProjectPreviewWorkspaceRecord["status"];
    lastPreviewFileRelativePath: string | null;
    sendPromptWhenThreadExists: boolean;
  }) => {
    if (!activeProjectRef || !activeProject || !api) {
      return;
    }
    const modelSelection = resolvePreviewThreadModelSelection(activeProject);
    const reusableThreadId = resolveExistingPreviewThreadId(input.existingThreadId);

    const createPreviewThread = async (threadId: ThreadId, createdAt: string) => {
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: activeProjectRef.projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      stageOptimisticThreadShell(
        buildOptimisticPreviewThreadShell({
          threadId,
          projectId: activeProjectRef.projectId,
          title: input.title,
          modelSelection,
          createdAt,
        }),
        activeProjectRef.environmentId,
      );
    };

    const startPreviewThreadTurn = async (threadId: ThreadId, createdAt: string) => {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        modelSelection,
        titleSeed: input.title,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });
    };

    const openThread = async (threadId: ThreadId, createdAt: string, isExistingThread: boolean) => {
      if (!isExistingThread) {
        await createPreviewThread(threadId, createdAt);
      }

      await navigateToPreviewThread(threadId);

      if (!isExistingThread || input.sendPromptWhenThreadExists) {
        await startPreviewThreadTurn(threadId, createdAt);
      }

      await persistWorkspaceThreadRecordBestEffort({
        workspaceRootRelativePath: input.workspaceRootRelativePath,
        threadId,
        status: input.status,
        lastPreviewFileRelativePath: input.lastPreviewFileRelativePath,
        lastError: null,
      });
    };

    if (reusableThreadId) {
      try {
        await openThread(reusableThreadId, new Date().toISOString(), true);
        return;
      } catch (error) {
        const fallbackThreadId = newThreadId();
        const fallbackCreatedAt = new Date().toISOString();
        await createPreviewThread(fallbackThreadId, fallbackCreatedAt);
        await navigateToPreviewThread(fallbackThreadId);
        await startPreviewThreadTurn(fallbackThreadId, fallbackCreatedAt);
        await persistWorkspaceThreadRecordBestEffort({
          workspaceRootRelativePath: input.workspaceRootRelativePath,
          threadId: fallbackThreadId,
          status: input.status,
          lastPreviewFileRelativePath: input.lastPreviewFileRelativePath,
          lastError: error instanceof Error ? error.message : "Failed to reuse preview thread.",
        });
        return;
      }
    }

    await openThread(newThreadId(), new Date().toISOString(), false);
  };

  const openBootstrapThread = async (sendPromptWhenThreadExists = true) => {
    if (!activeProjectRef || !api || !activeProjectState?.currentRelativePath) {
      return;
    }
    const payload = await api.preview.prepareBootstrapThread({
      projectId: activeProjectRef.projectId,
      relativePath: activeProjectState.currentRelativePath,
    });
    await openOrResumePreviewThread({
      workspaceRootRelativePath: payload.workspaceRootRelativePath,
      existingThreadId: payload.existingThreadId,
      title: payload.threadTitle,
      prompt: payload.initialPrompt,
      status: "bootstrapping",
      lastPreviewFileRelativePath: activeProjectState.currentPreviewFileRelativePath,
      sendPromptWhenThreadExists,
    });
  };

  const openPreviewGenerationThread = async (sendPromptWhenThreadExists = true) => {
    if (!activeProjectRef || !api || !activeProjectState?.currentRelativePath) {
      return;
    }
    const payload = await api.preview.preparePreviewGenerationTurn({
      projectId: activeProjectRef.projectId,
      relativePath: activeProjectState.currentRelativePath,
    });
    await openOrResumePreviewThread({
      workspaceRootRelativePath: payload.workspaceRootRelativePath,
      existingThreadId: payload.threadId,
      title: buildPreviewSetupThreadTitle(payload.workspaceRootRelativePath),
      prompt: payload.turnPrompt,
      status: "generation_in_progress",
      lastPreviewFileRelativePath: payload.previewFileRelativePath,
      sendPromptWhenThreadExists,
    });
  };

  const openPreviewRepairThread = async (sendPromptWhenThreadExists = true) => {
    if (!activeProjectRef || !api || !activeProjectState?.currentRelativePath) {
      return;
    }
    if (!currentRuntimeErrorMessage) {
      return;
    }
    const payload = await api.preview.preparePreviewRepairTurn({
      projectId: activeProjectRef.projectId,
      relativePath: activeProjectState.currentRelativePath,
      errorMessage: currentRuntimeErrorMessage,
      previewFileRelativePath: currentRuntimeErrorPreviewFileRelativePath,
    });
    await openOrResumePreviewThread({
      workspaceRootRelativePath: payload.workspaceRootRelativePath,
      existingThreadId: payload.threadId,
      title: buildPreviewSetupThreadTitle(payload.workspaceRootRelativePath),
      prompt: payload.turnPrompt,
      status: "repair_in_progress",
      lastPreviewFileRelativePath: payload.previewFileRelativePath,
      sendPromptWhenThreadExists,
    });
  };

  useEffect(() => {
    const nextTurnKey =
      activeRouteLatestTurn && activeRouteLatestTurn.state !== "running"
        ? `${activeRouteLatestTurn.turnId}:${activeRouteLatestTurn.state}:${activeRouteLatestTurn.completedAt ?? ""}`
        : null;
    if (
      !activeProjectRef ||
      routeTarget?.kind !== "server" ||
      routeTarget.threadRef.environmentId !== activeProjectRef.environmentId ||
      activeRouteThread?.projectId !== activeProjectRef.projectId ||
      !nextTurnKey
    ) {
      handledPreviewTurnKeyRef.current = null;
      return;
    }
    if (handledPreviewTurnKeyRef.current === nextTurnKey) {
      return;
    }
    handledPreviewTurnKeyRef.current = nextTurnKey;
    void refreshInspection().then(resolveCurrentTarget);
  }, [
    activeProjectRef,
    activeRouteLatestTurn?.completedAt,
    activeRouteLatestTurn?.state,
    activeRouteLatestTurn?.turnId,
    activeRouteThread?.projectId,
    routeTarget?.kind,
    routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : null,
  ]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!activeProjectRef || !event.data || event.data.source !== "forma-component-harness") {
        return;
      }
      const projectState =
        usePreviewWorkspaceStore.getState().projectStateByKey[scopedProjectKey(activeProjectRef)] ??
        null;

      if (
        event.data.kind === "preview.ready" &&
        typeof event.data.runtimeInstanceId === "string" &&
        typeof event.data.previewFileRelativePath === "string"
      ) {
        const message = event.data as PreviewReadyMessage;
        if (
          projectState?.currentPreviewFileRelativePath &&
          projectState.currentPreviewFileRelativePath !== message.previewFileRelativePath
        ) {
          return;
        }
        runtimeCommandWatermarkRef.current[message.runtimeInstanceId] = 0;
        applyRuntimeSnapshot(message, message.argOverrides);
        restoreSessionIntoRuntime(message);
        return;
      }
      if (
        event.data.kind === "preview.state" &&
        typeof event.data.runtimeInstanceId === "string" &&
        typeof event.data.previewFileRelativePath === "string"
      ) {
        const message = event.data as PreviewStateMessage;
        if (
          projectState?.currentPreviewFileRelativePath &&
          projectState.currentPreviewFileRelativePath !== message.previewFileRelativePath
        ) {
          return;
        }
        if (
          projectState?.runtimeSnapshot?.runtimeInstanceId &&
          projectState.runtimeSnapshot.runtimeInstanceId !== message.runtimeInstanceId
        ) {
          return;
        }
        const latestSentCommandId =
          runtimeCommandWatermarkRef.current[message.runtimeInstanceId] ?? 0;
        if (message.lastAppliedCommandId < latestSentCommandId) {
          return;
        }
        applyRuntimeSnapshot(message, message.argOverrides);
        return;
      }
      if (
        event.data.kind === "preview.runtime.error" &&
        typeof event.data.message === "string" &&
        typeof event.data.previewFileRelativePath === "string"
      ) {
        const message = event.data as PreviewRuntimeErrorMessage;
        if (
          projectState?.currentPreviewFileRelativePath &&
          projectState.currentPreviewFileRelativePath !== message.previewFileRelativePath
        ) {
          return;
        }
        if (
          projectState?.runtimeSnapshot?.runtimeInstanceId &&
          projectState.runtimeSnapshot.runtimeInstanceId !== message.runtimeInstanceId
        ) {
          return;
        }
        patchProjectState(activeProjectRef, {
          runtimeState: {
            kind: "runtime.error",
            projectId: activeProjectRef.projectId,
            message: message.message,
          },
        });
      }
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [
    activeProjectRef,
    activeProjectRef?.projectId,
    applyRuntimeSnapshot,
    patchProjectState,
    restoreSessionIntoRuntime,
  ]);

  const launchBootstrapAction = async () => {
    if (launchingAction) {
      return;
    }
    setActionErrorMessage(null);
    setLaunchingAction("bootstrap");
    try {
      await openBootstrapThread(true);
    } catch (error) {
      setActionErrorMessage(
        error instanceof Error ? error.message : "Failed to open the preview setup thread.",
      );
    } finally {
      setLaunchingAction(null);
    }
  };

  const launchGenerationAction = async () => {
    if (launchingAction) {
      return;
    }
    setActionErrorMessage(null);
    setLaunchingAction("generation");
    try {
      await openPreviewGenerationThread(true);
    } catch (error) {
      setActionErrorMessage(
        error instanceof Error ? error.message : "Failed to open the preview generation thread.",
      );
    } finally {
      setLaunchingAction(null);
    }
  };

  const launchRepairAction = async () => {
    if (launchingAction) {
      return;
    }
    setActionErrorMessage(null);
    setLaunchingAction("repair");
    try {
      await openPreviewRepairThread(true);
    } catch (error) {
      setActionErrorMessage(
        error instanceof Error ? error.message : "Failed to open the preview repair thread.",
      );
    } finally {
      setLaunchingAction(null);
    }
  };

  const handleSetControlValue = (name: string, value: unknown, mode: "debounced" | "immediate") => {
    if (!activeProjectRef || !activePreviewFileRelativePath) {
      return;
    }

    updateProjectState(activeProjectRef, (state) => ({
      ...state,
      sessionsByPreviewFilePath: upsertPreviewFileSession(
        state.sessionsByPreviewFilePath,
        activePreviewFileRelativePath,
        (session) => ({
          ...session,
          draftArgOverrides: {
            ...session.draftArgOverrides,
            [name]: value,
          },
          updatedAt: new Date().toISOString(),
        }),
      ),
    }));

    queuePendingArgsPartial(
      activePreviewFileRelativePath,
      {
        [name]: value,
      },
      mode === "immediate",
    );
  };

  const handleSelectScenario = (scenarioId: string) => {
    if (
      !activeProjectRef ||
      !runtimeSnapshot?.runtimeInstanceId ||
      !activePreviewFileRelativePath
    ) {
      return;
    }

    clearPendingArgsForPreviewFile(activePreviewFileRelativePath);
    updateProjectState(activeProjectRef, (state) => ({
      ...state,
      sessionsByPreviewFilePath: upsertPreviewFileSession(
        state.sessionsByPreviewFilePath,
        activePreviewFileRelativePath,
        (session) => ({
          ...session,
          selectedScenarioId: scenarioId,
          draftArgOverrides: {},
          updatedAt: new Date().toISOString(),
        }),
      ),
    }));
    void sendPreviewCommandForActiveRuntime({
      kind: "preview.command.selectScenario",
      runtimeInstanceId: runtimeSnapshot.runtimeInstanceId,
      previewFileRelativePath: activePreviewFileRelativePath,
      scenarioId,
    });
  };

  const handleFlushControl = (name: string) => {
    if (!activePreviewFileRelativePath) {
      return;
    }
    const pendingPartialArgs = pendingArgsPartialsRef.current[activePreviewFileRelativePath];
    if (!pendingPartialArgs || !Object.prototype.hasOwnProperty.call(pendingPartialArgs, name)) {
      return;
    }
    flushPendingArgsForPreviewFile(activePreviewFileRelativePath);
  };

  const fullHeightActionLabel = fullHeight ? "Restore drawer height" : "Expand to full height";

  useEffect(() => {
    if (
      !activeProjectRef ||
      !api ||
      !resolved ||
      shouldUseDirectIframe ||
      activeProjectState?.accessToken
    ) {
      return;
    }
    let cancelled = false;
    void api.preview
      .issueAccessToken({
        projectId: activeProjectRef.projectId,
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        patchProjectState(activeProjectRef, {
          accessToken: result.accessToken,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        patchProjectState(activeProjectRef, {
          accessToken: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeProjectRef,
    activeProjectState?.accessToken,
    api,
    patchProjectState,
    resolved,
    shouldUseDirectIframe,
  ]);

  if (!activeProjectRef) {
    return (
      <div
        ref={drawerRef}
        className="relative border-t border-border/80 bg-background"
        style={{ height: fullHeight ? "100%" : `${drawerHeight}px` }}
      >
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
        <div className="absolute right-2 top-2 z-20">
          <Button
            size="icon-xs"
            variant="outline"
            onClick={() => setFullHeight(!fullHeight)}
            aria-label={fullHeightActionLabel}
            title={fullHeightActionLabel}
          >
            {fullHeight ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronUpIcon className="size-3.5" />
            )}
          </Button>
        </div>
        <div className="h-full overflow-auto px-4 py-4">
          <div className="text-sm font-semibold text-foreground">Preview</div>
          <div className="mt-1 text-sm text-muted-foreground">
            Open preview for the current editor file to render it here.
          </div>
        </div>
      </div>
    );
  }

  const inspection = activeProjectState?.inspection ?? null;
  const currentRelativePath = activeProjectState?.currentRelativePath ?? null;
  const runtimeErrorResolution =
    activeProjectState?.resolution?.status === "runtimeError"
      ? activeProjectState.resolution
      : null;
  const runtimeErrorEvent =
    activeProjectState?.runtimeState?.kind === "runtime.error"
      ? activeProjectState.runtimeState
      : null;

  return (
    <div
      ref={drawerRef}
      className="relative border-t border-border/80 bg-background"
      style={{ height: fullHeight ? "100%" : `${drawerHeight}px` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />
      <div className="relative h-full min-h-0 overflow-hidden">
        <div className="absolute top-3 px-4 z-30 w-full flex items-center justify-between gap-1.5">
          {iframeUrl ? (
            <Popover>
              <PopoverTrigger
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background/88 px-2.5 text-foreground text-xs shadow-sm backdrop-blur-md transition-colors hover:bg-accent"
                type="button"
              >
                Controls
                <ChevronDownIcon className="size-3 fill-current opacity-60" />
              </PopoverTrigger>
              <PopoverPopup align="start" side="bottom" sideOffset={6}>
                <PreviewControlsContent
                  scenarioItems={scenarioItems}
                  selectedScenarioId={selectedScenarioId}
                  controls={displayedControls}
                  onSelectScenario={handleSelectScenario}
                  onSetControlValue={handleSetControlValue}
                  onFlushControl={handleFlushControl}
                />
              </PopoverPopup>
            </Popover>
          ) : null}
          <div className="inline-flex h-6 items-center overflow-hidden rounded-md border border-border/70 bg-background/88 shadow-sm backdrop-blur-md">
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => setFullHeight(!fullHeight)}
              aria-label={fullHeightActionLabel}
              title={fullHeightActionLabel}
            >
              {fullHeight ? (
                <ChevronDownIcon className="size-3 fill-current" />
              ) : (
                <ChevronUpIcon className="size-3 fill-current" />
              )}
            </button>
            <div className="h-4 w-px bg-border/80" />
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center text-foreground/90 transition-colors hover:bg-accent"
              onClick={closePreviewDrawer}
              aria-label="Close preview"
              title="Close preview"
            >
              <XIcon className="size-2.5 fill-current" />
            </button>
            {activeProjectState?.currentRelativePath ? (
              <>
                <div className="h-4 w-px bg-border/80" />
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center text-foreground/90 transition-colors hover:bg-accent"
                  onClick={() =>
                    void restartPreviewRuntime().then(refreshInspection).then(resolveCurrentTarget)
                  }
                  aria-label="Refresh preview"
                  title="Refresh preview"
                >
                  <RefreshIcon className="size-3 fill-current" />
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="h-full min-h-0 overflow-auto">
          {activeProjectState?.resolution?.status === "needsBootstrap" ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="w-full max-w-md rounded-xl border border-border/70 bg-card/80 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <PreviewIcon className="size-4" />
                  Repo isn't set up for previews
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {activeProjectState.resolution.reason}
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <Button
                    disabled={launchingAction !== null}
                    onClick={() => void launchBootstrapAction()}
                  >
                    {launchingAction === "bootstrap"
                      ? "Opening setup thread…"
                      : "Set up previews now"}
                  </Button>
                </div>
                {actionErrorMessage ? (
                  <p className="mt-3 text-sm text-destructive">{actionErrorMessage}</p>
                ) : null}
              </div>
            </div>
          ) : activeProjectState?.resolution?.status === "needsGeneration" ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="w-full max-w-md rounded-xl border border-border/70 bg-card/80 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <IconSparkles className="size-4" />
                  This component needs a preview file
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {activeProjectState.resolution.reason}
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <Button
                    disabled={launchingAction !== null}
                    onClick={() => void launchGenerationAction()}
                  >
                    {launchingAction === "generation"
                      ? "Opening preview thread…"
                      : "Generate preview now"}
                  </Button>
                </div>
                {actionErrorMessage ? (
                  <p className="mt-3 text-sm text-destructive">{actionErrorMessage}</p>
                ) : null}
              </div>
            </div>
          ) : runtimeErrorResolution ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="w-full max-w-xl rounded-xl border border-destructive/40 bg-destructive/5 p-4 shadow-sm">
                <div className="text-sm font-semibold text-foreground">Preview runtime error</div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {runtimeErrorResolution.message}
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <Button
                    disabled={launchingAction !== null}
                    onClick={() => void launchRepairAction()}
                  >
                    {launchingAction === "repair" ? "Opening repair thread…" : "Repair preview now"}
                  </Button>
                </div>
                {actionErrorMessage ? (
                  <p className="mt-3 text-sm text-destructive">{actionErrorMessage}</p>
                ) : null}
              </div>
            </div>
          ) : runtimeErrorEvent ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="w-full max-w-xl rounded-xl border border-destructive/40 bg-destructive/5 p-4 shadow-sm">
                <div className="text-sm font-semibold text-foreground">Preview runtime error</div>
                <p className="mt-2 text-sm text-muted-foreground">{runtimeErrorEvent.message}</p>
                <div className="mt-4 flex items-center gap-2">
                  <Button
                    disabled={launchingAction !== null}
                    onClick={() => void launchRepairAction()}
                  >
                    {launchingAction === "repair" ? "Opening repair thread…" : "Repair preview now"}
                  </Button>
                </div>
              </div>
            </div>
          ) : activeProjectState?.resolution?.status === "unsupportedTarget" ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="w-full max-w-md rounded-xl border border-border/70 bg-card/80 p-4 text-sm text-muted-foreground shadow-sm">
                {activeProjectState.resolution.reason}
              </div>
            </div>
          ) : activeProjectState?.resolution?.status === "notFound" ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="w-full max-w-md rounded-xl border border-border/70 bg-card/80 p-4 text-sm text-muted-foreground shadow-sm">
                Forma could not find this file in the current project workspace.
              </div>
            </div>
          ) : iframeUrl ? (
            <iframe
              ref={iframeRef}
              key={resolved?.iframePath}
              className="block h-full min-h-full w-full bg-background"
              sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
              src={iframeUrl}
              title="Component preview canvas"
            />
          ) : activeProjectState?.currentRelativePath &&
            (!resolved || (!shouldUseDirectIframe && !activeProjectState.accessToken)) ? (
            <div className="flex h-full min-h-[18rem] items-center justify-center text-sm text-muted-foreground">
              {resolved ? "Authorizing preview…" : "Resolving preview…"}
            </div>
          ) : (
            <div className="flex h-full min-h-[18rem] items-center justify-center text-sm text-muted-foreground">
              Open a component file from the editor to render it here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
