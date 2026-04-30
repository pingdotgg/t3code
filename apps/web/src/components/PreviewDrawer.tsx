import { scopeProjectRef, scopeThreadRef } from "@forma/client-runtime";
import type {
  ModelSelection,
  ProjectPreviewWorkspaceRecord,
  ScopedProjectRef,
  ThreadId,
} from "@forma/contracts";
import { DEFAULT_MODEL_BY_PROVIDER } from "@forma/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  IconArrowClockwise as RefreshIcon,
  IconChevronLeft,
  IconChevronRight,
  IconSparkles,
  IconRectangleOnRectangle as PreviewIcon,
} from "symbols-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../environmentApi";
import { getEnvironmentHttpBaseUrl, resolveEnvironmentHttpUrl } from "../environments/runtime";
import { useBottomDrawerUiStore } from "../bottomDrawerUiStore";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import { openPreviewTarget } from "../previewTargets";
import { type PreviewControlDescriptor, usePreviewWorkspaceStore } from "../previewWorkspaceStore";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { Project } from "../types";
import { waitForStartedServerThread } from "./ChatView.logic";
import { Button } from "./ui/button";
import { ProjectFavicon } from "./ProjectFavicon";

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

function updateControlValue(
  controls: readonly PreviewControlDescriptor[],
  name: string,
  value: unknown,
): PreviewControlDescriptor[] {
  return controls.map((control) => (control.name === name ? { ...control, value } : control));
}

function workspaceLabel(workspaceRootRelativePath: string): string {
  return workspaceRootRelativePath.trim().length > 0 ? workspaceRootRelativePath : "project root";
}

function buildPreviewSetupThreadTitle(workspaceRootRelativePath: string): string {
  return `Preview setup · ${workspaceLabel(workspaceRootRelativePath)}`;
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

function PreviewControlsRail(props: {
  controls: readonly PreviewControlDescriptor[];
  showEnableControlsCta: boolean;
  onEnableBridge: () => void;
  onChangeControl: (name: string, value: unknown) => void;
}) {
  if (props.controls.length === 0) {
    return (
      <div className="w-72 shrink-0 border-l border-border/70 bg-card/40 p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
          Controls
        </div>
        <div className="mt-3 rounded-xl border border-border/70 bg-background/80 p-3">
          <div className="text-sm text-muted-foreground">
            {props.showEnableControlsCta
              ? "Plain preview is ready. Open the preview setup thread to enable interactive controls."
              : "No interactive controls are available for this variant."}
          </div>
          {props.showEnableControlsCta ? (
            <Button size="sm" className="mt-3" onClick={props.onEnableBridge}>
              Enable interactive controls
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="w-72 shrink-0 border-l border-border/70 bg-card/40 p-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
        Controls
      </div>
      <div className="mt-4 space-y-4">
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
                    props.onChangeControl(control.name, event.currentTarget.checked)
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
            return (
              <label key={control.name} className="flex flex-col gap-2 text-sm">
                <span className="font-medium text-foreground">{control.label}</span>
                <select
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={typeof control.value === "string" ? control.value : ""}
                  onChange={(event) =>
                    props.onChangeControl(control.name, event.currentTarget.value)
                  }
                >
                  {(control.options ?? []).map((option) => (
                    <option key={String(option)} value={String(option)}>
                      {String(option)}
                    </option>
                  ))}
                </select>
              </label>
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
                            props.onChangeControl(control.name, [...nextValues]);
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
                      props.onChangeControl(control.name, JSON.parse(event.currentTarget.value));
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
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                type={inputType}
                min={control.min ?? undefined}
                max={control.max ?? undefined}
                step={control.step ?? undefined}
                value={
                  inputType === "number" || inputType === "range"
                    ? typeof control.value === "number"
                      ? control.value
                      : 0
                    : typeof control.value === "string"
                      ? control.value
                      : ""
                }
                onChange={(event) =>
                  props.onChangeControl(
                    control.name,
                    inputType === "number" || inputType === "range"
                      ? Number(event.currentTarget.value)
                      : event.currentTarget.value,
                  )
                }
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function PreviewDrawer() {
  const navigate = useNavigate();
  const sharedHeight = useBottomDrawerUiStore((state) => state.sharedHeight);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const {
    activeProjectRef,
    patchProjectState,
    projectStateByKey,
    resetProjectState,
    setActiveProjectRef,
  } = usePreviewWorkspaceStore(
    useShallow((state) => ({
      activeProjectRef: state.activeProjectRef,
      patchProjectState: state.patchProjectState,
      projectStateByKey: state.projectStateByKey,
      resetProjectState: state.resetProjectState,
      setActiveProjectRef: state.setActiveProjectRef,
    })),
  );
  const [componentQuery, setComponentQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    ReadonlyArray<{ relativePath: string; displayName: string }>
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [commandOverride, setCommandOverride] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

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
  const api = activeProjectRef ? readEnvironmentApi(activeProjectRef.environmentId) : undefined;

  const refreshInspection = useCallback(async () => {
    if (!activeProjectRef || !api || !activeProject) {
      return;
    }
    const result = await api.preview.inspectProject({
      projectId: activeProjectRef.projectId,
      cwd: activeProject.cwd,
    });
    patchProjectState(activeProjectRef, {
      inspection: result,
      controlsBridgeStatus: result.controlsBridgeStatus,
    });
    setCommandOverride((currentValue) => {
      if (currentValue.trim().length > 0 || result.detectedStartCommands.length === 0) {
        return currentValue;
      }
      return result.detectedStartCommands[0] ?? "";
    });
  }, [activeProject, activeProjectRef, api, patchProjectState]);

  const restartPreviewRuntime = useCallback(async () => {
    if (!activeProjectRef || !api) {
      return;
    }
    patchProjectState(activeProjectRef, {
      runtimeState: {
        kind: "runtime.starting",
        projectId: activeProjectRef.projectId,
      },
      accessToken: null,
      controls: [],
      ephemeralArgs: {},
    });
    await api.preview.stopRuntime({
      projectId: activeProjectRef.projectId,
    });
  }, [activeProjectRef, api, patchProjectState]);

  const resolveCurrentTarget = useCallback(async () => {
    if (!activeProjectRef || !api) {
      return;
    }
    const projectKey = `${activeProjectRef.environmentId}:${activeProjectRef.projectId}`;
    const latestProjectState = usePreviewWorkspaceStore.getState().projectStateByKey[projectKey];
    if (!latestProjectState?.currentRelativePath || !latestProjectState.currentTargetKind) {
      return;
    }

    try {
      const resolution = await api.preview.resolveTarget({
        projectId: activeProjectRef.projectId,
        relativePath: latestProjectState.currentRelativePath,
        targetKind: latestProjectState.currentTargetKind,
      });

      const previousStoryId = latestProjectState.currentStoryId;
      const preservedVariantIndex =
        resolution.status === "resolved" && previousStoryId
          ? resolution.variants.findIndex((variant) => variant.storyId === previousStoryId)
          : -1;
      const shouldPreserveVariantState = preservedVariantIndex >= 0;

      patchProjectState(activeProjectRef, {
        resolution,
        runtimeState: resolution.status === "resolved" ? latestProjectState.runtimeState : null,
        storyChoices: resolution.status === "needsStoryChoice" ? resolution.storyChoices : [],
        currentComponentRelativePath:
          resolution.status === "resolved"
            ? (resolution.componentRelativePath ?? latestProjectState.currentComponentRelativePath)
            : resolution.status === "needsStoryChoice" || resolution.status === "needsStoryWork"
              ? resolution.componentRelativePath
              : latestProjectState.currentComponentRelativePath,
        currentStoryRelativePath:
          resolution.status === "resolved"
            ? resolution.storyRelativePath
            : resolution.status === "needsStoryWork"
              ? resolution.storyRelativePath
              : latestProjectState.currentStoryRelativePath,
        currentStoryId:
          resolution.status === "resolved"
            ? shouldPreserveVariantState
              ? previousStoryId
              : resolution.initialStoryId
            : null,
        currentVariantIndex:
          resolution.status === "resolved"
            ? shouldPreserveVariantState
              ? preservedVariantIndex
              : 0
            : 0,
        ephemeralArgs: shouldPreserveVariantState ? latestProjectState.ephemeralArgs : {},
        controls: shouldPreserveVariantState ? latestProjectState.controls : [],
      });
    } catch (error) {
      patchProjectState(activeProjectRef, {
        resolution: null,
        runtimeState: {
          kind: "runtime.error",
          projectId: activeProjectRef.projectId,
          message: error instanceof Error ? error.message : "Failed to resolve preview target.",
        },
      });
    }
  }, [activeProjectRef, api, patchProjectState]);

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
  }, [refreshInspection]);

  useEffect(() => {
    setCommandOverride("");
  }, [activeProjectRef?.environmentId, activeProjectRef?.projectId]);

  useEffect(() => {
    const nextResolutionCommandChoices =
      activeProjectState?.resolution?.status === "needsCommandOverride"
        ? activeProjectState.resolution.detectedCommands
        : [];
    if (commandOverride.trim().length > 0 || nextResolutionCommandChoices.length === 0) {
      return;
    }
    setCommandOverride(nextResolutionCommandChoices[0] ?? "");
  }, [activeProjectState?.resolution, commandOverride]);

  useEffect(() => {
    if (
      !activeProjectRef ||
      !api ||
      !activeProjectState?.currentRelativePath ||
      !activeProjectState.currentTargetKind
    ) {
      return;
    }
    void resolveCurrentTarget();
  }, [
    activeProjectRef,
    activeProjectState?.currentRelativePath,
    activeProjectState?.currentTargetKind,
    api,
    resolveCurrentTarget,
  ]);

  useEffect(() => {
    if (!activeProjectRef || !api) return;
    const query = componentQuery.trim();
    if (query.length === 0) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void api.preview
        .searchComponents({
          projectId: activeProjectRef.projectId,
          query,
          limit: 12,
        })
        .then((result) => setSearchResults(result.components))
        .catch(() => setSearchResults([]))
        .finally(() => setSearchLoading(false));
    }, 160);
    return () => window.clearTimeout(timer);
  }, [activeProjectRef, api, componentQuery]);

  const resolved =
    activeProjectState?.resolution?.status === "resolved" ? activeProjectState.resolution : null;
  const variants = resolved?.variants ?? [];
  const currentVariant =
    variants.length > 0
      ? variants[Math.min(activeProjectState?.currentVariantIndex ?? 0, variants.length - 1)]
      : null;
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
    activeProjectRef && resolved && currentVariant
      ? shouldUseDirectIframe && resolved.directIframeUrl
        ? resolved.directIframeUrl.replace(
            /id=[^&]+/,
            `id=${encodeURIComponent(currentVariant.storyId)}`,
          )
        : activeProjectState?.accessToken
          ? resolvePreviewUrl(
              activeProjectRef,
              `${resolved.iframePath.replace(/id=[^&]+/, `id=${encodeURIComponent(currentVariant.storyId)}`)}`,
              activeProjectState.accessToken,
            )
          : null
      : null;

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

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (
        !activeProjectRef ||
        !currentVariant ||
        !event.data ||
        event.data.source !== "forma-storybook-preview-bridge" ||
        event.data.kind !== "preview.story.state" ||
        event.data.storyId !== currentVariant.storyId ||
        !Array.isArray(event.data.controls)
      ) {
        return;
      }
      patchProjectState(activeProjectRef, {
        controls: event.data.controls as PreviewControlDescriptor[],
      });
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [activeProjectRef, currentVariant, patchProjectState]);

  useEffect(() => {
    if (!iframeRef.current?.contentWindow || !currentVariant) {
      return;
    }
    iframeRef.current.contentWindow.postMessage(
      {
        source: "forma-preview-parent",
        kind: "preview.args.update",
        storyId: currentVariant.storyId,
        args: activeProjectState?.ephemeralArgs ?? {},
      },
      "*",
    );
  }, [activeProjectState?.ephemeralArgs, currentVariant]);

  const persistWorkspaceThreadRecord = useCallback(
    async (input: {
      workspaceRootRelativePath: string;
      threadId: ThreadId;
      status: ProjectPreviewWorkspaceRecord["status"];
      lastTargetRelativePath: string | null;
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
        lastTargetRelativePath: input.lastTargetRelativePath,
        lastError: input.lastError,
        updatedAt: new Date().toISOString(),
      });
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: activeProjectRef.projectId,
        previewWorkspaceRecords: nextRecords,
      });
    },
    [activeProjectRef, api],
  );

  const openOrResumePreviewThread = useCallback(
    async (input: {
      workspaceRootRelativePath: string;
      existingThreadId: ThreadId | null;
      title: string;
      prompt: string;
      status: ProjectPreviewWorkspaceRecord["status"];
      lastTargetRelativePath: string | null;
      sendPromptWhenThreadExists: boolean;
    }) => {
      if (!activeProjectRef || !activeProject || !api) {
        return;
      }
      const modelSelection = resolvePreviewThreadModelSelection(activeProject);
      const createdAt = new Date().toISOString();
      const threadId = input.existingThreadId ?? newThreadId();

      if (!input.existingThreadId) {
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
      }

      await persistWorkspaceThreadRecord({
        workspaceRootRelativePath: input.workspaceRootRelativePath,
        threadId,
        status: input.status,
        lastTargetRelativePath: input.lastTargetRelativePath,
        lastError: null,
      });

      if (!input.existingThreadId || input.sendPromptWhenThreadExists) {
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
      }

      if (!input.existingThreadId) {
        await waitForStartedServerThread(
          scopeThreadRef(activeProjectRef.environmentId, threadId),
          1_500,
        );
      }

      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(activeProjectRef.environmentId, threadId)),
      });
    },
    [activeProject, activeProjectRef, api, navigate, persistWorkspaceThreadRecord],
  );

  const openPreviewSetupThread = useCallback(
    async (sendPromptWhenThreadExists = false) => {
      if (
        !activeProjectRef ||
        !api ||
        !activeProjectState?.currentRelativePath ||
        !activeProjectState.currentTargetKind
      ) {
        return;
      }
      const payload = await api.preview.prepareWorkspaceSetupThread({
        projectId: activeProjectRef.projectId,
        relativePath: activeProjectState.currentRelativePath,
        targetKind: activeProjectState.currentTargetKind,
      });
      await openOrResumePreviewThread({
        workspaceRootRelativePath: payload.workspaceRootRelativePath,
        existingThreadId: payload.existingThreadId,
        title: payload.threadTitle,
        prompt: payload.initialPrompt,
        status: "setup_in_progress",
        lastTargetRelativePath: activeProjectState.currentRelativePath,
        sendPromptWhenThreadExists,
      });
    },
    [activeProjectRef, activeProjectState, api, openOrResumePreviewThread],
  );

  const openStoryWorkThread = useCallback(
    async (action: "create" | "fix") => {
      if (!activeProjectRef || !api || !activeProjectState?.currentComponentRelativePath) {
        return;
      }
      const payload = await api.preview.prepareStoryWorkTurn({
        projectId: activeProjectRef.projectId,
        componentRelativePath: activeProjectState.currentComponentRelativePath,
        action,
      });
      await openOrResumePreviewThread({
        workspaceRootRelativePath: payload.workspaceRootRelativePath,
        existingThreadId: payload.threadId,
        title: buildPreviewSetupThreadTitle(payload.workspaceRootRelativePath),
        prompt: payload.turnPrompt,
        status: "story_work_pending",
        lastTargetRelativePath: activeProjectState.currentRelativePath,
        sendPromptWhenThreadExists: true,
      });
    },
    [activeProjectRef, activeProjectState, api, openOrResumePreviewThread],
  );

  const handleChangeControl = useCallback(
    (name: string, value: unknown) => {
      if (!activeProjectRef || !activeProjectState) {
        return;
      }
      patchProjectState(activeProjectRef, {
        controls: updateControlValue(activeProjectState.controls, name, value),
        ephemeralArgs: {
          ...activeProjectState.ephemeralArgs,
          [name]: value,
        },
      });
    },
    [activeProjectRef, activeProjectState, patchProjectState],
  );

  if (!activeProjectRef) {
    return (
      <div
        className="border-t border-border/80 bg-background"
        style={{ height: `${sharedHeight}px` }}
      >
        <div className="h-full overflow-auto px-4 pb-4 pt-14">
          <div className="text-sm font-semibold text-foreground">Preview</div>
          <div className="mt-1 text-sm text-muted-foreground">
            Select a project to browse component previews.
          </div>
          <div className="mt-4 grid gap-2">
            {projects.map((project) => (
              <button
                key={`${project.environmentId}:${project.id}`}
                className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-3 text-left transition-colors hover:bg-accent/40"
                onClick={() =>
                  setActiveProjectRef(scopeProjectRef(project.environmentId, project.id))
                }
                type="button"
              >
                <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {project.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {project.cwd}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const inspection = activeProjectState?.inspection ?? null;
  const resolutionCommandChoices =
    activeProjectState?.resolution?.status === "needsCommandOverride"
      ? activeProjectState.resolution.detectedCommands
      : [];
  const storyWorkResolution =
    activeProjectState?.resolution?.status === "needsStoryWork"
      ? activeProjectState.resolution
      : null;
  const showCommandOverride = activeProjectState?.resolution?.status === "needsCommandOverride";
  const showBridgeCta =
    resolved &&
    activeProjectState?.controlsBridgeStatus === "missing" &&
    activeProjectState.controls.length === 0;

  return (
    <div
      className="border-t border-border/80 bg-background"
      style={{ height: `${sharedHeight}px` }}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border/70 px-4 pb-3 pt-14">
          <select
            className="max-w-80 rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={`${activeProjectRef.environmentId}:${activeProjectRef.projectId}`}
            onChange={(event) => {
              const next = projects.find(
                (project) => `${project.environmentId}:${project.id}` === event.currentTarget.value,
              );
              if (!next) return;
              setActiveProjectRef(scopeProjectRef(next.environmentId, next.id));
            }}
          >
            {projects.map((project) => (
              <option
                key={`${project.environmentId}:${project.id}`}
                value={`${project.environmentId}:${project.id}`}
              >
                {project.name}
              </option>
            ))}
          </select>
          <input
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            placeholder="Search components..."
            value={componentQuery}
            onChange={(event) => setComponentQuery(event.currentTarget.value)}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!activeProjectRef) return;
              resetProjectState(activeProjectRef);
            }}
          >
            Reset
          </Button>
        </div>

        {componentQuery.trim().length > 0 && !activeProjectState?.currentRelativePath ? (
          <div className="border-b border-border/70 px-4 py-2">
            {searchLoading ? <div className="text-sm text-muted-foreground">Searching…</div> : null}
            <div className="grid gap-1">
              {searchResults.map((result) => (
                <button
                  key={result.relativePath}
                  type="button"
                  className="rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  onClick={() => {
                    setComponentQuery(result.displayName);
                    openPreviewTarget(activeProjectRef, {
                      targetKind: "component",
                      relativePath: result.relativePath,
                    });
                  }}
                >
                  <div className="text-sm font-medium text-foreground">{result.displayName}</div>
                  <div className="text-xs text-muted-foreground">{result.relativePath}</div>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">
                  {activeProject?.name ?? "Preview"}
                  {activeProjectState?.currentRelativePath
                    ? ` · ${activeProjectState.currentRelativePath}`
                    : ""}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeProjectState?.runtimeState?.kind === "runtime.ready"
                    ? "Live preview connected"
                    : activeProjectState?.runtimeState?.kind === "runtime.starting"
                      ? "Starting Storybook…"
                      : activeProjectState?.runtimeState?.kind === "runtime.error"
                        ? activeProjectState.runtimeState.message
                        : (inspection?.summary ?? "Search for a component to preview")}
                </div>
              </div>
              {resolved ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon-xs"
                    onClick={() =>
                      void restartPreviewRuntime()
                        .then(refreshInspection)
                        .then(resolveCurrentTarget)
                    }
                    aria-label="Refresh preview"
                  >
                    <RefreshIcon className="size-3.5" />
                  </Button>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={(activeProjectState?.currentVariantIndex ?? 0) <= 0}
                      onClick={() => {
                        if (!activeProjectRef) return;
                        const nextIndex = Math.max(
                          (activeProjectState?.currentVariantIndex ?? 0) - 1,
                          0,
                        );
                        patchProjectState(activeProjectRef, {
                          currentVariantIndex: nextIndex,
                          currentStoryId: variants[nextIndex]?.storyId ?? null,
                          ephemeralArgs: {},
                          controls: [],
                        });
                      }}
                    >
                      <IconChevronLeft className="size-4" />
                    </Button>
                    <div className="min-w-36 text-center text-sm text-foreground">
                      {currentVariant?.name ?? "Variant"}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={
                        (activeProjectState?.currentVariantIndex ?? 0) >= variants.length - 1
                      }
                      onClick={() => {
                        if (!activeProjectRef) return;
                        const nextIndex = Math.min(
                          (activeProjectState?.currentVariantIndex ?? 0) + 1,
                          variants.length - 1,
                        );
                        patchProjectState(activeProjectRef, {
                          currentVariantIndex: nextIndex,
                          currentStoryId: variants[nextIndex]?.storyId ?? null,
                          ephemeralArgs: {},
                          controls: [],
                        });
                      }}
                    >
                      <IconChevronRight className="size-4" />
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4">
              {activeProjectState?.resolution?.status === "needsWorkspaceSetup" ? (
                <div className="rounded-xl border border-border/70 bg-card/60 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <PreviewIcon className="size-4" />
                    {activeProjectState.resolution.existingThreadId
                      ? "Resume preview setup thread"
                      : `Set up previews for ${workspaceLabel(activeProjectState.resolution.ownerWorkspaceRootRelativePath)}`}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {activeProjectState.resolution.reason}
                  </p>
                  <Button className="mt-4" onClick={() => void openPreviewSetupThread()}>
                    {activeProjectState.resolution.existingThreadId
                      ? "Open setup thread"
                      : `Set up ${workspaceLabel(activeProjectState.resolution.ownerWorkspaceRootRelativePath)}`}
                  </Button>
                </div>
              ) : activeProjectState?.runtimeState?.kind === "runtime.error" &&
                activeProjectState?.currentRelativePath ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
                  <div className="text-sm font-semibold text-foreground">
                    Failed to start Storybook preview runtime
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {activeProjectState.runtimeState.message}
                  </p>
                  <div className="mt-4 flex items-center gap-2">
                    <Button
                      onClick={() =>
                        void restartPreviewRuntime()
                          .then(refreshInspection)
                          .then(resolveCurrentTarget)
                      }
                    >
                      Retry preview
                    </Button>
                  </div>
                </div>
              ) : showCommandOverride ? (
                <div className="rounded-xl border border-border/70 bg-card/60 p-4">
                  <div className="text-sm font-semibold text-foreground">
                    Choose a Storybook start command
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Forma found Storybook, but it needs one explicit command to start the preview
                    runtime.
                  </p>
                  <input
                    className="mt-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={commandOverride}
                    onChange={(event) => setCommandOverride(event.currentTarget.value)}
                    placeholder="bun run storybook"
                  />
                  {resolutionCommandChoices.length > 0 ||
                  inspection?.detectedStartCommands.length ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(resolutionCommandChoices.length > 0
                        ? resolutionCommandChoices
                        : (inspection?.detectedStartCommands ?? [])
                      ).map((command) => (
                        <Button
                          key={command}
                          size="sm"
                          variant="outline"
                          onClick={() => setCommandOverride(command)}
                        >
                          {command}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-4 flex items-center gap-2">
                    <Button
                      onClick={() => {
                        if (
                          !activeProjectRef ||
                          !api ||
                          commandOverride.trim().length === 0 ||
                          activeProjectState?.resolution?.status !== "needsCommandOverride"
                        )
                          return;
                        void api.preview
                          .setStartCommandOverride({
                            projectId: activeProjectRef.projectId,
                            workspaceRootRelativePath:
                              activeProjectState.resolution.workspaceRootRelativePath,
                            command: commandOverride.trim(),
                          })
                          .then(restartPreviewRuntime)
                          .then(refreshInspection)
                          .then(resolveCurrentTarget);
                      }}
                    >
                      Save command
                    </Button>
                  </div>
                </div>
              ) : activeProjectState?.resolution?.status === "needsStoryChoice" ? (
                <div className="rounded-xl border border-border/70 bg-card/60 p-4">
                  <div className="text-sm font-semibold text-foreground">Choose a story file</div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Forma found multiple story files for this component. Pick the one this preview
                    canvas should use.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {activeProjectState.resolution.storyChoices.map((choice) => (
                      <Button
                        key={choice.relativePath}
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (
                            !api ||
                            !activeProjectRef ||
                            !activeProjectState.currentComponentRelativePath
                          )
                            return;
                          void api.preview
                            .chooseStoryMapping({
                              projectId: activeProjectRef.projectId,
                              componentRelativePath:
                                activeProjectState.currentComponentRelativePath,
                              storyRelativePath: choice.relativePath,
                            })
                            .then(resolveCurrentTarget);
                        }}
                      >
                        {choice.displayName}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : activeProjectState?.resolution?.status === "needsStoryWork" ? (
                <div className="rounded-xl border border-border/70 bg-card/60 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <IconSparkles className="size-4" />
                    {storyWorkResolution?.action === "create" ? "Create story" : "Fix story"}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {storyWorkResolution?.action === "create"
                      ? "The workspace preview runtime is ready, but this component still needs a Storybook story."
                      : "The workspace preview runtime is ready, but the selected story needs to be fixed before it can render in the preview drawer."}
                  </p>
                  <Button
                    className="mt-4"
                    onClick={() =>
                      void openStoryWorkThread(storyWorkResolution?.action ?? "create")
                    }
                  >
                    {storyWorkResolution?.threadId
                      ? storyWorkResolution.action === "create"
                        ? "Create story in setup thread"
                        : "Fix story in setup thread"
                      : storyWorkResolution?.action === "create"
                        ? "Create story"
                        : "Fix story"}
                  </Button>
                </div>
              ) : activeProjectState?.resolution?.status === "unsupportedTarget" ? (
                <div className="rounded-xl border border-border/70 bg-card/60 p-4 text-sm text-muted-foreground">
                  {activeProjectState.resolution.reason}
                </div>
              ) : activeProjectState?.resolution?.status === "notFound" ? (
                <div className="rounded-xl border border-border/70 bg-card/60 p-4 text-sm text-muted-foreground">
                  Forma could not find this file in the current project workspace.
                </div>
              ) : iframeUrl ? (
                <div className="h-full min-h-[18rem] overflow-hidden rounded-xl border border-border/70 bg-white shadow-sm">
                  <iframe
                    ref={iframeRef}
                    key={iframeUrl}
                    className="h-full min-h-[18rem] w-full bg-white"
                    sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                    src={iframeUrl}
                    title="Component preview canvas"
                  />
                </div>
              ) : activeProjectState?.currentRelativePath &&
                (!resolved || (!shouldUseDirectIframe && !activeProjectState.accessToken)) ? (
                <div className="flex h-full min-h-[18rem] items-center justify-center rounded-xl border border-dashed border-border/80 bg-card/30 text-sm text-muted-foreground">
                  {resolved ? "Authorizing preview…" : "Resolving preview…"}
                </div>
              ) : (
                <div className="flex h-full min-h-[18rem] items-center justify-center rounded-xl border border-dashed border-border/80 bg-card/30 text-sm text-muted-foreground">
                  Search for a component or open preview from a file.
                </div>
              )}
            </div>
          </div>

          <PreviewControlsRail
            controls={activeProjectState?.controls ?? []}
            showEnableControlsCta={Boolean(showBridgeCta)}
            onEnableBridge={() => void openPreviewSetupThread(true)}
            onChangeControl={handleChangeControl}
          />
        </div>
      </div>
    </div>
  );
}
