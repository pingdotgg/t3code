/**
 * ComponentPreviewPanel - right-panel surface for the component preview
 * harness.
 *
 * Renders live component previews built from the user's own project via the
 * server's component preview runtime (an isolated Vite dev server). Ported
 * from the fork's bottom-drawer implementation onto the right-panel surface
 * system and the atom-based environment RPC layer.
 *
 * Unrelated to the desktop webview browser preview surface.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  ComponentPreviewResolveTargetResult,
  ModelSelection,
  ProjectComponentPreviewWorkspaceRecord,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  IconApplepencilTip as AnnotationIcon,
  IconArrowClockwise as RefreshIcon,
  IconChevronDown as ChevronDownIcon,
  IconMagnifyingglass as SearchIcon,
  IconPaperplane as SendFeedbackIcon,
  IconRectangleOnRectangle as PreviewIcon,
  IconSparkles,
} from "symbols-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type PreviewControlDescriptor,
  type PreviewRuntimeSnapshot,
  useComponentPreviewWorkspaceStore,
} from "../componentPreviewWorkspaceStore";
import {
  buildPreviewFeedbackPrompt,
  buildPreviewFeedbackScopeKey,
  filterAnnotationsForActiveScope,
  markPreviewFeedbackAnnotationsSent,
  stableHashPreviewArgs,
  type PreviewFeedbackAnnotation,
  type PreviewFeedbackScope,
} from "../previewFeedback";
import {
  buildSessionFromRuntimeSnapshot,
  getPreviewFileSession,
  mergePreviewControlsWithDrafts,
  normalizeSelectedScenarioId,
  upsertPreviewFileSession,
} from "../componentPreviewSessionState";
import { isDynamicImportFetchErrorMessage } from "../previewRecovery";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import { componentPreviewEnvironment } from "../state/componentPreview";
import { readProject, readThreadShell, useProject, useThreadShell } from "../state/entities";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { Button } from "./ui/button";
import { SidebarArchiveIcon } from "./icons/custom";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const PREVIEW_PARENT_SOURCE = "t3-component-preview-parent";
const PREVIEW_RUNTIME_SOURCE = "t3-component-harness";
const COMPONENT_PREVIEW_TOKEN_QUERY_PARAM = "componentPreviewToken";

function unwrapAtomCommandResult<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") {
    return result.value;
  }
  const failure = Cause.squash(result.cause);
  throw failure instanceof Error ? failure : new Error(String(failure));
}

function PreviewFeedbackEyeIcon({ size = 16, isOpen = true }: { size?: number; isOpen?: boolean }) {
  if (!isOpen) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M18.6025 9.28503C18.9174 8.9701 19.4364 8.99481 19.7015 9.35271C20.1484 9.95606 20.4943 10.507 20.7342 10.9199C21.134 11.6086 21.1329 12.4454 20.7303 13.1328C20.2144 14.013 19.2151 15.5225 17.7723 16.8193C16.3293 18.1162 14.3852 19.2497 12.0008 19.25C11.4192 19.25 10.8638 19.1823 10.3355 19.0613C9.77966 18.934 9.63498 18.2525 10.0382 17.8493C10.2412 17.6463 10.5374 17.573 10.8188 17.6302C11.1993 17.7076 11.5935 17.75 12.0008 17.75C13.8848 17.7497 15.4867 16.8568 16.7693 15.7041C18.0522 14.5511 18.9606 13.1867 19.4363 12.375C19.5656 12.1543 19.5659 11.8943 19.4373 11.6729C19.2235 11.3049 18.921 10.8242 18.5364 10.3003C18.3085 9.98991 18.3302 9.5573 18.6025 9.28503ZM12.0008 4.75C12.5814 4.75006 13.1358 4.81803 13.6632 4.93953C14.2182 5.06741 14.362 5.74812 13.9593 6.15091C13.7558 6.35435 13.4589 6.42748 13.1771 6.36984C12.7983 6.29239 12.4061 6.25006 12.0008 6.25C10.1167 6.25 8.51415 7.15145 7.23028 8.31543C5.94678 9.47919 5.03918 10.8555 4.56426 11.6729C4.43551 11.8945 4.43582 12.1542 4.56524 12.375C4.77587 12.7343 5.07189 13.2012 5.44718 13.7105C5.67623 14.0213 5.65493 14.4552 5.38193 14.7282C5.0671 15.0431 4.54833 15.0189 4.28292 14.6614C3.84652 14.0736 3.50813 13.5369 3.27129 13.1328C2.86831 12.4451 2.86717 11.6088 3.26739 10.9199C3.78185 10.0345 4.77959 8.51239 6.22247 7.2041C7.66547 5.89584 9.61202 4.75 12.0008 4.75Z"
          fill="currentColor"
        />
        <path d="M5 19L19 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3.91752 12.7539C3.65127 12.2996 3.65037 11.7515 3.9149 11.2962C4.9042 9.59346 7.72688 5.49994 12 5.49994C16.2731 5.49994 19.0958 9.59346 20.0851 11.2962C20.3496 11.7515 20.3487 12.2996 20.0825 12.7539C19.0908 14.4459 16.2694 18.4999 12 18.4999C7.73064 18.4999 4.90918 14.4459 3.91752 12.7539Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 14.8261C13.5608 14.8261 14.8261 13.5608 14.8261 12C14.8261 10.4392 13.5608 9.17392 12 9.17392C10.4392 9.17392 9.17391 10.4392 9.17391 12C9.17391 13.5608 10.4392 14.8261 12 14.8261Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PreviewViewportIcon({
  viewportId,
  size = 16,
}: {
  viewportId: PreviewViewportId;
  size?: number;
}) {
  if (viewportId === "desktop") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect
          x="4.75"
          y="5.75"
          width="14.5"
          height="10.5"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M9 19.25H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M12 16.25V19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (viewportId === "tablet") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect
          x="7.25"
          y="3.75"
          width="9.5"
          height="16.5"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M11.25 17.25H12.75"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (viewportId === "mobile" || viewportId === "small-mobile") {
    const width = viewportId === "small-mobile" ? 7.5 : 8.5;
    const x = (24 - width) / 2;
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect
          x={x}
          y="3.75"
          width={width}
          height="16.5"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M11.35 17.25H12.65"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8.5 4.75H5.75C5.19772 4.75 4.75 5.19772 4.75 5.75V8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M15.5 4.75H18.25C18.8023 4.75 19.25 5.19772 19.25 5.75V8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M8.5 19.25H5.75C5.19772 19.25 4.75 18.8023 4.75 18.25V15.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M15.5 19.25H18.25C18.8023 19.25 19.25 18.8023 19.25 18.25V15.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PreviewZoomIcon({ zoomId, size = 16 }: { zoomId: PreviewZoomId; size?: number }) {
  if (zoomId === "fit") {
    return <PreviewViewportIcon viewportId="fit" size={size} />;
  }

  const indicator =
    zoomId === "50" || zoomId === "75" ? "minus" : zoomId === "125" ? "plus" : "dot";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle
        cx="10.75"
        cy="10.75"
        r={zoomId === "75" ? "4.75" : "5.75"}
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M15.25 15.25L19.25 19.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {indicator === "minus" ? (
        <path d="M8.5 10.75H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : indicator === "plus" ? (
        <>
          <path d="M8.5 10.75H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M10.75 8.5V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : (
        <circle cx="10.75" cy="10.75" r="1" fill="currentColor" />
      )}
    </svg>
  );
}

const previewChromePillStyle = {
  background: "color-mix(in srgb, var(--popover, var(--background)) 88%, transparent)",
  color: "var(--foreground)",
  border: "1px solid color-mix(in srgb, var(--border) 88%, transparent)",
  boxShadow: "0 1px 2px color-mix(in srgb, var(--foreground) 10%, transparent)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
} satisfies CSSProperties;

function previewChromeIconButtonStyle(active: boolean): CSSProperties {
  return {
    color: active ? "var(--primary)" : "color-mix(in srgb, var(--foreground) 90%, transparent)",
    ...(active ? { backgroundColor: "color-mix(in srgb, var(--primary) 14%, transparent)" } : {}),
  };
}

function resolvePreviewUrl(
  environmentHttpBaseUrl: string,
  iframePath: string,
  accessToken: string,
): string | null {
  const [rawPathname = "/", search = ""] = iframePath.split("?");
  const searchParams = new URLSearchParams(search);
  searchParams.set(COMPONENT_PREVIEW_TOKEN_QUERY_PARAM, accessToken);
  try {
    const url = new URL(rawPathname, environmentHttpBaseUrl);
    url.search = searchParams.toString();
    return url.toString();
  } catch {
    return null;
  }
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

function buildPreviewFeedbackThreadTitle(previewFileRelativePath: string): string {
  const fileName = previewFileRelativePath.split(/[\\/]/).at(-1) ?? previewFileRelativePath;
  return `Preview feedback · ${fileName}`;
}

function resolvePreviewThreadModelSelection(project: {
  defaultModelSelection: ModelSelection | null;
}): ModelSelection {
  const codexDriver = ProviderDriverKind.make("codex");
  return (
    project.defaultModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL_BY_PROVIDER[codexDriver] ?? DEFAULT_MODEL,
    }
  );
}

function upsertPreviewWorkspaceRecord(
  existingRecords: readonly ProjectComponentPreviewWorkspaceRecord[] | undefined,
  nextRecord: ProjectComponentPreviewWorkspaceRecord,
): ProjectComponentPreviewWorkspaceRecord[] {
  const remaining = (existingRecords ?? []).filter(
    (record) => record.workspaceRootRelativePath !== nextRecord.workspaceRootRelativePath,
  );
  return [...remaining, nextRecord].toSorted((left, right) =>
    left.workspaceRootRelativePath.localeCompare(right.workspaceRootRelativePath),
  );
}

type PreviewParentCommandMessage =
  | {
      source: typeof PREVIEW_PARENT_SOURCE;
      kind: "preview.command.restoreSession";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      commandId: number;
      selectedScenarioId: string | null;
      argOverrides: Record<string, unknown>;
    }
  | {
      source: typeof PREVIEW_PARENT_SOURCE;
      kind: "preview.command.selectScenario";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      commandId: number;
      scenarioId: string;
    }
  | {
      source: typeof PREVIEW_PARENT_SOURCE;
      kind: "preview.command.setArgsPartial";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      commandId: number;
      argsPartial: Record<string, unknown>;
    }
  | {
      source: typeof PREVIEW_PARENT_SOURCE;
      kind: "preview.viewport.update";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      viewport: {
        id: PreviewViewportId;
        width: number | null;
        height: number | null;
      };
      uiScale: number;
    }
  | {
      source: typeof PREVIEW_PARENT_SOURCE;
      kind: "preview.feedback.setEnabled";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      enabled: boolean;
    }
  | {
      source: typeof PREVIEW_PARENT_SOURCE;
      kind: "preview.feedback.setMarkersVisible";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      visible: boolean;
    }
  | {
      source: typeof PREVIEW_PARENT_SOURCE;
      kind: "preview.feedback.syncAnnotations";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      annotations: PreviewFeedbackAnnotation[];
    }
  | {
      source: typeof PREVIEW_PARENT_SOURCE;
      kind: "preview.feedback.setTheme";
      runtimeInstanceId: string;
      previewFileRelativePath: string;
      primaryColor: string;
    };

interface PreviewRuntimeSnapshotMessage {
  source: typeof PREVIEW_RUNTIME_SOURCE;
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
  source: typeof PREVIEW_RUNTIME_SOURCE;
  kind: "preview.runtime.error";
  runtimeInstanceId: string;
  previewFileRelativePath: string;
  message: string;
}

interface PreviewFeedbackCreatedMessage {
  source: typeof PREVIEW_RUNTIME_SOURCE;
  kind: "preview.feedback.created";
  runtimeInstanceId: string;
  previewFileRelativePath: string;
  annotation: PreviewFeedbackAnnotation;
}

function resolveDocumentPrimaryColor(): string {
  if (typeof document === "undefined") {
    return "var(--primary)";
  }
  const primaryColor = getComputedStyle(document.documentElement).getPropertyValue("--primary");
  return primaryColor.trim() || "var(--primary)";
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

const PREVIEW_VIEWPORTS = [
  { id: "fit", label: "Fit", width: null, height: null },
  { id: "desktop", label: "Desktop", width: 1280, height: 800 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "mobile", label: "Mobile", width: 390, height: 844 },
  { id: "small-mobile", label: "Small", width: 360, height: 740 },
] as const;

type PreviewViewportId = (typeof PREVIEW_VIEWPORTS)[number]["id"];

const PREVIEW_ZOOM_LEVELS = [
  { id: "fit", label: "Fit", value: null },
  { id: "50", label: "50%", value: 0.5 },
  { id: "75", label: "75%", value: 0.75 },
  { id: "100", label: "100%", value: 1 },
  { id: "125", label: "125%", value: 1.25 },
] as const;

type PreviewZoomId = (typeof PREVIEW_ZOOM_LEVELS)[number]["id"];

function resolvePreviewViewport(viewportId: PreviewViewportId) {
  return PREVIEW_VIEWPORTS.find((viewport) => viewport.id === viewportId) ?? PREVIEW_VIEWPORTS[0];
}

function resolvePreviewZoom(zoomId: PreviewZoomId) {
  return PREVIEW_ZOOM_LEVELS.find((zoom) => zoom.id === zoomId) ?? PREVIEW_ZOOM_LEVELS[0];
}

interface NormalizedControlOption {
  key: string;
  label: string;
  value: string;
  rawValue: unknown;
}

function isControlOptionRecord(option: unknown): option is { label?: unknown; value?: unknown } {
  return typeof option === "object" && option !== null && "value" in option;
}

function stringifyControlOptionValue(value: unknown): string {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${value}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (value === null) return "null:null";
  try {
    return `json:${JSON.stringify(value)}`;
  } catch {
    return `string:${String(value)}`;
  }
}

function normalizeControlOption(option: unknown): NormalizedControlOption {
  const value = isControlOptionRecord(option) ? option.value : option;
  const label =
    isControlOptionRecord(option) && option.label != null ? String(option.label) : String(value);
  return {
    key: stringifyControlOptionValue(value),
    label,
    value: stringifyControlOptionValue(value),
    rawValue: value,
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
              const selectItems = (control.options ?? []).map(normalizeControlOption);
              const currentValue = stringifyControlOptionValue(control.value);
              return (
                <div key={control.name} className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-foreground">{control.label}</span>
                  <Select
                    items={selectItems}
                    value={currentValue}
                    onValueChange={(value) => {
                      if (typeof value !== "string") {
                        return;
                      }
                      const selectedItem = selectItems.find((item) => item.key === value);
                      if (selectedItem) {
                        props.onSetControlValue(control.name, selectedItem.rawValue, "immediate");
                      }
                    }}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {selectItems.map((item) => (
                        <SelectItem key={item.key} value={item.key} hideIndicator>
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
              const currentValues = Array.isArray(control.value)
                ? control.value.map(stringifyControlOptionValue)
                : [];
              return (
                <div key={control.name} className="space-y-2 text-sm">
                  <div className="font-medium text-foreground">{control.label}</div>
                  <div className="space-y-2">
                    {(control.options ?? []).map((option) => {
                      const item = normalizeControlOption(option);
                      const checked = currentValues.includes(item.key);
                      return (
                        <label
                          key={item.key}
                          className="flex items-center gap-2 text-muted-foreground"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const nextValues = new Set(currentValues);
                              if (event.currentTarget.checked) {
                                nextValues.add(item.key);
                              } else {
                                nextValues.delete(item.key);
                              }
                              props.onSetControlValue(
                                control.name,
                                (control.options ?? [])
                                  .map(normalizeControlOption)
                                  .filter((candidate) => nextValues.has(candidate.key))
                                  .map((candidate) => candidate.rawValue),
                                "immediate",
                              );
                            }}
                          />
                          {item.label}
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

function PreviewViewportControl(props: {
  selectedViewportId: PreviewViewportId;
  onSelectViewport: (viewportId: PreviewViewportId) => void;
}) {
  return (
    <div
      className="pointer-events-auto inline-flex h-7 items-center overflow-hidden rounded-md"
      style={previewChromePillStyle}
    >
      {PREVIEW_VIEWPORTS.map((viewport) => {
        const active = props.selectedViewportId === viewport.id;
        const title =
          viewport.width && viewport.height
            ? `${viewport.label} viewport (${viewport.width}x${viewport.height})`
            : `${viewport.label} viewport`;
        return (
          <button
            key={viewport.id}
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-none border-0 bg-transparent transition-colors hover:bg-accent active:scale-[0.92]"
            style={previewChromeIconButtonStyle(active)}
            onClick={() => props.onSelectViewport(viewport.id)}
            aria-label={title}
            aria-pressed={active}
            title={title}
          >
            <PreviewViewportIcon viewportId={viewport.id} size={16} />
          </button>
        );
      })}
    </div>
  );
}

function PreviewZoomControl(props: {
  selectedZoomId: PreviewZoomId;
  onSelectZoom: (zoomId: PreviewZoomId) => void;
}) {
  return (
    <div
      className="pointer-events-auto inline-flex h-7 items-center overflow-hidden rounded-md"
      style={previewChromePillStyle}
    >
      {PREVIEW_ZOOM_LEVELS.map((zoom) => {
        const active = props.selectedZoomId === zoom.id;
        return (
          <button
            key={zoom.id}
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-none border-0 bg-transparent transition-colors hover:bg-accent active:scale-[0.92]"
            style={previewChromeIconButtonStyle(active)}
            onClick={() => props.onSelectZoom(zoom.id)}
            aria-label={`Zoom ${zoom.label}`}
            aria-pressed={active}
            title={`Zoom ${zoom.label}`}
          >
            <PreviewZoomIcon zoomId={zoom.id} size={16} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Streams component preview project events into the workspace store while an
 * active project is mounted.
 */
function ComponentPreviewProjectEventsBridge({ projectRef }: { projectRef: ScopedProjectRef }) {
  const patchProjectState = useComponentPreviewWorkspaceStore((state) => state.patchProjectState);
  const eventResult = useAtomValue(
    componentPreviewEnvironment.projectEvents({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  useEffect(() => {
    if (eventResult._tag !== "Success") {
      return;
    }
    patchProjectState(projectRef, { runtimeState: eventResult.value });
  }, [eventResult, patchProjectState, projectRef]);
  return null;
}

function ComponentPreviewTargetPicker(props: { projectRef: ScopedProjectRef }) {
  const searchComponents = useAtomCommand(componentPreviewEnvironment.searchComponents, {
    reportFailure: false,
  });
  const patchProjectState = useComponentPreviewWorkspaceStore((state) => state.patchProjectState);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    ReadonlyArray<{ relativePath: string; displayName: string }>
  >([]);
  const [searching, setSearching] = useState(false);
  const searchNonceRef = useRef(0);

  useEffect(() => {
    const nonce = ++searchNonceRef.current;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timeoutId = window.setTimeout(() => {
      void searchComponents({
        environmentId: props.projectRef.environmentId,
        input: {
          projectId: props.projectRef.projectId,
          query: trimmed,
          limit: 25,
        },
      }).then((result) => {
        if (searchNonceRef.current !== nonce) {
          return;
        }
        setSearching(false);
        if (result._tag === "Success") {
          setResults(result.value.components);
        } else {
          setResults([]);
        }
      });
    }, 200);
    return () => window.clearTimeout(timeoutId);
  }, [props.projectRef.environmentId, props.projectRef.projectId, query, searchComponents]);

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
        <SearchIcon className="size-3.5 shrink-0 fill-current text-muted-foreground" />
        <input
          className="w-full bg-transparent text-sm outline-none"
          placeholder="Search components to preview…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      {query.trim().length > 0 ? (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border/70 bg-card/80">
          {results.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">
              {searching ? "Searching…" : "No matching component files."}
            </div>
          ) : (
            results.map((entry) => (
              <button
                key={entry.relativePath}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-accent"
                onClick={() => {
                  patchProjectState(props.projectRef, {
                    currentRelativePath: entry.relativePath,
                    currentPreviewFileRelativePath: null,
                    runtimeSnapshot: null,
                    runtimeState: null,
                    resolution: null,
                    accessToken: null,
                  });
                }}
              >
                <span className="text-sm text-foreground">{entry.displayName}</span>
                <span className="text-xs text-muted-foreground">{entry.relativePath}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ComponentPreviewPanel() {
  const navigate = useNavigate();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeRouteThread = useThreadShell(routeThreadRef);
  const {
    activeProjectRef,
    setActiveProjectRef,
    patchProjectState,
    projectStateByKey,
    updateProjectState,
  } = useComponentPreviewWorkspaceStore(
    useShallow((state) => ({
      activeProjectRef: state.activeProjectRef,
      setActiveProjectRef: state.setActiveProjectRef,
      patchProjectState: state.patchProjectState,
      updateProjectState: state.updateProjectState,
      projectStateByKey: state.projectStateByKey,
    })),
  );

  // The surface is thread-scoped; default the active preview project to the
  // project that owns the visible thread when nothing was explicitly opened.
  const routeProjectRef = useMemo(
    () =>
      routeThreadRef && activeRouteThread
        ? scopeProjectRef(routeThreadRef.environmentId, activeRouteThread.projectId)
        : null,
    [activeRouteThread, routeThreadRef],
  );
  useEffect(() => {
    if (!activeProjectRef && routeProjectRef) {
      setActiveProjectRef(routeProjectRef);
    }
  }, [activeProjectRef, routeProjectRef, setActiveProjectRef]);

  const inspectProjectCommand = useAtomCommand(componentPreviewEnvironment.inspectProject, {
    reportFailure: false,
  });
  const resolveTargetCommand = useAtomCommand(componentPreviewEnvironment.resolveTarget, {
    reportFailure: false,
  });
  const stopRuntimeCommand = useAtomCommand(componentPreviewEnvironment.stopRuntime, {
    reportFailure: false,
  });
  const issueAccessTokenCommand = useAtomCommand(componentPreviewEnvironment.issueAccessToken, {
    reportFailure: false,
  });
  const prepareBootstrapThreadCommand = useAtomCommand(
    componentPreviewEnvironment.prepareBootstrapThread,
    { reportFailure: false },
  );
  const prepareGenerationTurnCommand = useAtomCommand(
    componentPreviewEnvironment.prepareGenerationTurn,
    { reportFailure: false },
  );
  const prepareRepairTurnCommand = useAtomCommand(componentPreviewEnvironment.prepareRepairTurn, {
    reportFailure: false,
  });
  const createThreadCommand = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurnCommand = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const updateProjectCommand = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [launchingAction, setLaunchingAction] = useState<
    "bootstrap" | "generation" | "repair" | null
  >(null);
  const [previewViewportId, setPreviewViewportId] = useState<PreviewViewportId>("fit");
  const [previewZoomId, setPreviewZoomId] = useState<PreviewZoomId>("fit");
  const [previewFrameReloadNonce, setPreviewFrameReloadNonce] = useState(0);
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  const [feedbackMarkersVisible, setFeedbackMarkersVisible] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewCanvasRef = useRef<HTMLDivElement | null>(null);
  const [previewCanvasSize, setPreviewCanvasSize] = useState({ width: 0, height: 0 });
  const handledPreviewTurnKeyRef = useRef<string | null>(null);
  const nextPreviewCommandIdRef = useRef(1);
  const runtimeCommandWatermarkRef = useRef<Record<string, number>>({});
  const pendingArgsPartialsRef = useRef<Record<string, Record<string, unknown>>>({});
  const pendingArgsTimerRef = useRef<Record<string, number>>({});
  const previousPreviewFileRelativePathRef = useRef<string | null>(null);
  const recoveredIframeUrlRef = useRef<string | null>(null);

  const activeProject = useProject(activeProjectRef);
  const activeProjectState =
    activeProjectRef && projectStateByKey[scopedProjectKey(activeProjectRef)]
      ? projectStateByKey[scopedProjectKey(activeProjectRef)]!
      : null;
  const activeRouteLatestTurn = activeRouteThread?.latestTurn ?? null;
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
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(activeProjectRef?.environmentId ?? null);
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
    activeProjectRef && resolved && environmentHttpBaseUrl
      ? shouldUseDirectIframe && resolved.directIframeUrl
        ? resolved.directIframeUrl
        : activeProjectState?.accessToken
          ? resolvePreviewUrl(
              environmentHttpBaseUrl,
              resolved.iframePath,
              activeProjectState.accessToken,
            )
          : null
      : null;
  const previewViewport = resolvePreviewViewport(previewViewportId);
  const previewZoom = resolvePreviewZoom(previewZoomId);
  const [previewFeedbackPrimaryColor, setPreviewFeedbackPrimaryColor] = useState(
    resolveDocumentPrimaryColor,
  );
  const previewUiScale = useMemo(() => {
    const hasFixedPreviewViewport = Boolean(previewViewport.width || previewViewport.height);
    const fixedPreviewViewportWidth = previewViewport.width ?? previewCanvasSize.width;
    const fixedPreviewViewportHeight = previewViewport.height ?? previewCanvasSize.height;
    return hasFixedPreviewViewport &&
      fixedPreviewViewportWidth > 0 &&
      fixedPreviewViewportHeight > 0
      ? (previewZoom.value ??
          Math.min(
            1,
            Math.max(0.1, (previewCanvasSize.width - 64) / fixedPreviewViewportWidth),
            Math.max(0.1, (previewCanvasSize.height - 64) / fixedPreviewViewportHeight),
          ))
      : 1;
  }, [
    previewCanvasSize.height,
    previewCanvasSize.width,
    previewViewport.height,
    previewViewport.width,
    previewZoom.value,
  ]);
  const activeFeedbackScope = useMemo<PreviewFeedbackScope>(
    () => ({
      scenarioId: selectedScenarioId,
      scenarioName:
        scenarioChoices.find((choice) => choice.id === selectedScenarioId)?.name ??
        selectedScenarioId,
      argOverrides: activePreviewSession?.confirmedArgOverrides ?? {},
      argOverridesHash: stableHashPreviewArgs(activePreviewSession?.confirmedArgOverrides ?? {}),
      viewport: {
        id: previewViewport.id,
        width: previewViewport.width,
        height: previewViewport.height,
      },
    }),
    [
      activePreviewSession?.confirmedArgOverrides,
      previewViewport.height,
      previewViewport.id,
      previewViewport.width,
      scenarioChoices,
      selectedScenarioId,
    ],
  );
  const activeFeedbackAnnotations = useMemo(
    () =>
      filterAnnotationsForActiveScope(
        activePreviewSession?.feedbackAnnotations ?? [],
        activeFeedbackScope,
      ),
    [activeFeedbackScope, activePreviewSession?.feedbackAnnotations],
  );
  const unsentFeedbackCount = activeFeedbackAnnotations.filter(
    (annotation) => annotation.status === "unsent",
  ).length;

  const postPreviewCommand = useCallback((message: PreviewParentCommandMessage) => {
    const contentWindow = iframeRef.current?.contentWindow;
    if (!contentWindow) {
      return null;
    }
    if ("commandId" in message) {
      runtimeCommandWatermarkRef.current[message.runtimeInstanceId] = message.commandId;
    }
    contentWindow.postMessage(message, "*");
    return "commandId" in message ? message.commandId : null;
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const updatePrimaryColor = () => {
      setPreviewFeedbackPrimaryColor(resolveDocumentPrimaryColor());
    };
    updatePrimaryColor();
    const observer = new MutationObserver(updatePrimaryColor);
    observer.observe(root, {
      attributeFilter: ["style", "data-theme", "data-theme-mode", "data-theme-preference-mode"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);

  const syncPreviewFeedbackToRuntime = useCallback(
    (annotations: PreviewFeedbackAnnotation[] = activeFeedbackAnnotations) => {
      if (!runtimeSnapshot?.runtimeInstanceId || !activePreviewFileRelativePath) {
        return;
      }
      postPreviewCommand({
        source: PREVIEW_PARENT_SOURCE,
        kind: "preview.feedback.syncAnnotations",
        runtimeInstanceId: runtimeSnapshot.runtimeInstanceId,
        previewFileRelativePath: activePreviewFileRelativePath,
        annotations,
      });
      postPreviewCommand({
        source: PREVIEW_PARENT_SOURCE,
        kind: "preview.feedback.setTheme",
        runtimeInstanceId: runtimeSnapshot.runtimeInstanceId,
        previewFileRelativePath: activePreviewFileRelativePath,
        primaryColor: previewFeedbackPrimaryColor,
      });
      postPreviewCommand({
        source: PREVIEW_PARENT_SOURCE,
        kind: "preview.feedback.setEnabled",
        runtimeInstanceId: runtimeSnapshot.runtimeInstanceId,
        previewFileRelativePath: activePreviewFileRelativePath,
        enabled: feedbackEnabled,
      });
      postPreviewCommand({
        source: PREVIEW_PARENT_SOURCE,
        kind: "preview.feedback.setMarkersVisible",
        runtimeInstanceId: runtimeSnapshot.runtimeInstanceId,
        previewFileRelativePath: activePreviewFileRelativePath,
        visible: feedbackMarkersVisible,
      });
    },
    [
      activeFeedbackAnnotations,
      activePreviewFileRelativePath,
      feedbackEnabled,
      feedbackMarkersVisible,
      postPreviewCommand,
      previewFeedbackPrimaryColor,
      runtimeSnapshot?.runtimeInstanceId,
    ],
  );

  const syncPreviewFeedbackThemeToRuntime = useCallback(
    (runtimeInstanceId: string, previewFileRelativePath: string) => {
      postPreviewCommand({
        source: PREVIEW_PARENT_SOURCE,
        kind: "preview.feedback.setTheme",
        runtimeInstanceId,
        previewFileRelativePath,
        primaryColor: resolveDocumentPrimaryColor(),
      });
    },
    [postPreviewCommand],
  );

  const syncPreviewViewportToRuntime = useCallback(() => {
    if (!runtimeSnapshot?.runtimeInstanceId || !activePreviewFileRelativePath) {
      return;
    }
    postPreviewCommand({
      source: PREVIEW_PARENT_SOURCE,
      kind: "preview.viewport.update",
      runtimeInstanceId: runtimeSnapshot.runtimeInstanceId,
      previewFileRelativePath: activePreviewFileRelativePath,
      viewport: {
        id: previewViewport.id,
        width: previewViewport.width,
        height: previewViewport.height,
      },
      uiScale: previewUiScale,
    });
  }, [
    activePreviewFileRelativePath,
    postPreviewCommand,
    previewViewport,
    previewUiScale,
    runtimeSnapshot,
  ]);

  const refreshInspection = useCallback(async () => {
    if (!activeProjectRef || !activeProject) {
      return;
    }
    const result = await inspectProjectCommand({
      environmentId: activeProjectRef.environmentId,
      input: {
        projectId: activeProjectRef.projectId,
        cwd: activeProject.workspaceRoot,
      },
    });
    if (result._tag !== "Success") {
      return;
    }
    patchProjectState(activeProjectRef, {
      inspection: result.value,
    });
  }, [activeProject, activeProjectRef, inspectProjectCommand, patchProjectState]);

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
          source: PREVIEW_PARENT_SOURCE,
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
          source: PREVIEW_PARENT_SOURCE,
          kind: input.kind,
          runtimeInstanceId: input.runtimeInstanceId,
          previewFileRelativePath: input.previewFileRelativePath,
          commandId,
          scenarioId: input.scenarioId,
        });
      }
      return postPreviewCommand({
        source: PREVIEW_PARENT_SOURCE,
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
        useComponentPreviewWorkspaceStore.getState().projectStateByKey[
          scopedProjectKey(activeProjectRef)
        ] ?? null;
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
        useComponentPreviewWorkspaceStore.getState().projectStateByKey[
          scopedProjectKey(activeProjectRef)
        ] ?? null;
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

  const resolveCurrentTarget = useCallback(async () => {
    if (!activeProjectRef) {
      return null;
    }
    const latestProjectState =
      useComponentPreviewWorkspaceStore.getState().projectStateByKey[
        scopedProjectKey(activeProjectRef)
      ];
    if (!latestProjectState?.currentRelativePath) {
      return null;
    }

    try {
      const resolution: ComponentPreviewResolveTargetResult = unwrapAtomCommandResult(
        await resolveTargetCommand({
          environmentId: activeProjectRef.environmentId,
          input: {
            projectId: activeProjectRef.projectId,
            relativePath: latestProjectState.currentRelativePath,
          },
        }),
      );

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
      return resolution;
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
      return null;
    }
  }, [activeProjectRef, patchProjectState, resolveTargetCommand, updateProjectState]);

  const recoverPreviewRuntimeOnce = useCallback(
    async (reason: "timeout" | "dynamic-import") => {
      if (!activeProjectRef || !iframeUrl) {
        return;
      }
      if (recoveredIframeUrlRef.current === iframeUrl) {
        return;
      }
      recoveredIframeUrlRef.current = iframeUrl;
      patchProjectState(activeProjectRef, {
        runtimeState: {
          kind: "runtime.starting",
          projectId: activeProjectRef.projectId,
        },
        runtimeSnapshot: null,
      });
      const softResolution = await resolveCurrentTarget();
      if (softResolution?.status === "resolved") {
        setPreviewFrameReloadNonce((current) => current + 1);
        return;
      }
      if (
        reason === "dynamic-import" ||
        (softResolution?.status === "runtimeError" &&
          isDynamicImportFetchErrorMessage(softResolution.message))
      ) {
        await stopRuntimeCommand({
          environmentId: activeProjectRef.environmentId,
          input: { projectId: activeProjectRef.projectId },
        });
        await resolveCurrentTarget();
        setPreviewFrameReloadNonce((current) => current + 1);
      }
    },
    [activeProjectRef, iframeUrl, patchProjectState, resolveCurrentTarget, stopRuntimeCommand],
  );

  const restartPreviewRuntime = async () => {
    if (!activeProjectRef) {
      return;
    }
    clearPendingArgsForPreviewFile(activeProjectState?.currentPreviewFileRelativePath ?? null);
    const softResolution = await resolveCurrentTarget();
    if (
      softResolution?.status !== "runtimeError" ||
      !isDynamicImportFetchErrorMessage(softResolution.message)
    ) {
      setPreviewFrameReloadNonce((current) => current + 1);
      return;
    }
    patchProjectState(activeProjectRef, {
      runtimeState: {
        kind: "runtime.starting",
        projectId: activeProjectRef.projectId,
      },
      accessToken: null,
      runtimeSnapshot: null,
    });
    await stopRuntimeCommand({
      environmentId: activeProjectRef.environmentId,
      input: { projectId: activeProjectRef.projectId },
    });
    await resolveCurrentTarget();
    setPreviewFrameReloadNonce((current) => current + 1);
  };

  useEffect(() => {
    void refreshInspection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectRef?.environmentId, activeProjectRef?.projectId]);

  useEffect(() => {
    if (!activeProjectRef || !activeProjectState?.currentRelativePath) {
      return;
    }
    void resolveCurrentTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectRef, activeProjectState?.currentRelativePath]);

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
    status: ProjectComponentPreviewWorkspaceRecord["status"];
    lastPreviewFileRelativePath: string | null;
    lastError: string | null;
  }) => {
    if (!activeProjectRef) {
      return;
    }
    const latestProject = readProject(activeProjectRef);
    if (!latestProject) {
      return;
    }
    const nextRecords = upsertPreviewWorkspaceRecord(
      latestProject.componentPreviewWorkspaceRecords,
      {
        workspaceRootRelativePath: input.workspaceRootRelativePath,
        threadId: input.threadId,
        status: input.status,
        lastPreviewFileRelativePath: input.lastPreviewFileRelativePath,
        lastError: input.lastError,
        updatedAt: new Date().toISOString(),
      },
    );
    unwrapAtomCommandResult(
      await updateProjectCommand({
        environmentId: activeProjectRef.environmentId,
        input: {
          commandId: newCommandId(),
          projectId: activeProjectRef.projectId,
          componentPreviewWorkspaceRecords: nextRecords,
        },
      }),
    );
  };

  const persistWorkspaceThreadRecordBestEffort = async (input: {
    workspaceRootRelativePath: string;
    threadId: ThreadId;
    status: ProjectComponentPreviewWorkspaceRecord["status"];
    lastPreviewFileRelativePath: string | null;
    lastError: string | null;
  }) => {
    try {
      await persistWorkspaceThreadRecord(input);
    } catch (error) {
      console.error("Failed to persist component preview workspace record.", error);
    }
  };

  const resolveExistingPreviewThreadId = (threadId: ThreadId | null): ThreadId | null => {
    if (!activeProjectRef || !threadId) {
      return null;
    }
    const shell = readThreadShellForRef(activeProjectRef, threadId);
    return shell && shell.projectId === activeProjectRef.projectId ? threadId : null;
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
    status: ProjectComponentPreviewWorkspaceRecord["status"];
    lastPreviewFileRelativePath: string | null;
    sendPromptWhenThreadExists: boolean;
    persistWorkspaceRecord?: boolean;
  }) => {
    if (!activeProjectRef || !activeProject) {
      return;
    }
    const modelSelection = resolvePreviewThreadModelSelection(activeProject);
    const reusableThreadId = resolveExistingPreviewThreadId(input.existingThreadId);

    const createPreviewThread = async (threadId: ThreadId, createdAt: string) => {
      unwrapAtomCommandResult(
        await createThreadCommand({
          environmentId: activeProjectRef.environmentId,
          input: {
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
          },
        }),
      );
    };

    const startPreviewThreadTurn = async (threadId: ThreadId, createdAt: string) => {
      unwrapAtomCommandResult(
        await startThreadTurnCommand({
          environmentId: activeProjectRef.environmentId,
          input: {
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
          },
        }),
      );
    };

    const openThread = async (threadId: ThreadId, createdAt: string, isExistingThread: boolean) => {
      if (!isExistingThread) {
        await createPreviewThread(threadId, createdAt);
      }

      await navigateToPreviewThread(threadId);

      if (!isExistingThread || input.sendPromptWhenThreadExists) {
        await startPreviewThreadTurn(threadId, createdAt);
      }

      if (input.persistWorkspaceRecord ?? true) {
        await persistWorkspaceThreadRecordBestEffort({
          workspaceRootRelativePath: input.workspaceRootRelativePath,
          threadId,
          status: input.status,
          lastPreviewFileRelativePath: input.lastPreviewFileRelativePath,
          lastError: null,
        });
      }
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
        if (input.persistWorkspaceRecord ?? true) {
          await persistWorkspaceThreadRecordBestEffort({
            workspaceRootRelativePath: input.workspaceRootRelativePath,
            threadId: fallbackThreadId,
            status: input.status,
            lastPreviewFileRelativePath: input.lastPreviewFileRelativePath,
            lastError: error instanceof Error ? error.message : "Failed to reuse preview thread.",
          });
        }
        return;
      }
    }

    await openThread(newThreadId(), new Date().toISOString(), false);
  };

  const openBootstrapThread = async (sendPromptWhenThreadExists = true) => {
    if (!activeProjectRef || !activeProjectState?.currentRelativePath) {
      return;
    }
    const payload = unwrapAtomCommandResult(
      await prepareBootstrapThreadCommand({
        environmentId: activeProjectRef.environmentId,
        input: {
          projectId: activeProjectRef.projectId,
          relativePath: activeProjectState.currentRelativePath,
        },
      }),
    );
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
    if (!activeProjectRef || !activeProjectState?.currentRelativePath) {
      return;
    }
    const payload = unwrapAtomCommandResult(
      await prepareGenerationTurnCommand({
        environmentId: activeProjectRef.environmentId,
        input: {
          projectId: activeProjectRef.projectId,
          relativePath: activeProjectState.currentRelativePath,
        },
      }),
    );
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
    if (!activeProjectRef || !activeProjectState?.currentRelativePath) {
      return;
    }
    if (!currentRuntimeErrorMessage) {
      return;
    }
    const payload = unwrapAtomCommandResult(
      await prepareRepairTurnCommand({
        environmentId: activeProjectRef.environmentId,
        input: {
          projectId: activeProjectRef.projectId,
          relativePath: activeProjectState.currentRelativePath,
          errorMessage: currentRuntimeErrorMessage,
          previewFileRelativePath: currentRuntimeErrorPreviewFileRelativePath,
        },
      }),
    );
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

  const openPreviewFeedbackThread = async () => {
    if (!activeProjectRef || !activeProject || !activePreviewFileRelativePath) {
      return;
    }
    const unsentAnnotations = activeFeedbackAnnotations.filter(
      (annotation) => annotation.status === "unsent",
    );
    if (unsentAnnotations.length === 0) {
      return;
    }
    const workspaceRecord =
      activeProject.componentPreviewWorkspaceRecords?.find(
        (record) => record.lastPreviewFileRelativePath === activePreviewFileRelativePath,
      ) ??
      activeProject.componentPreviewWorkspaceRecords?.find((record) => record.threadId !== null) ??
      null;
    const workspaceRootRelativePath = workspaceRecord?.workspaceRootRelativePath ?? "";
    const prompt = buildPreviewFeedbackPrompt({
      previewFileRelativePath: activePreviewFileRelativePath,
      componentRelativePath:
        resolved?.relativePath ?? activeProjectState?.currentRelativePath ?? null,
      scope: activeFeedbackScope,
      annotations: unsentAnnotations,
    });
    await openOrResumePreviewThread({
      workspaceRootRelativePath,
      existingThreadId: null,
      title: buildPreviewFeedbackThreadTitle(activePreviewFileRelativePath),
      prompt,
      status: "ready",
      lastPreviewFileRelativePath: activePreviewFileRelativePath,
      sendPromptWhenThreadExists: false,
      persistWorkspaceRecord: false,
    });
    const sentAt = new Date().toISOString();
    const sentIds = unsentAnnotations.map((annotation) => annotation.id);
    updateProjectState(activeProjectRef, (currentState) => ({
      ...currentState,
      sessionsByPreviewFilePath: upsertPreviewFileSession(
        currentState.sessionsByPreviewFilePath,
        activePreviewFileRelativePath,
        (session) => ({
          ...session,
          feedbackAnnotations: markPreviewFeedbackAnnotationsSent(
            session.feedbackAnnotations,
            sentIds,
            sentAt,
          ),
          updatedAt: sentAt,
        }),
      ),
    }));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (!activeProjectRef || !event.data || event.data.source !== PREVIEW_RUNTIME_SOURCE) {
        return;
      }
      const projectState =
        useComponentPreviewWorkspaceStore.getState().projectStateByKey[
          scopedProjectKey(activeProjectRef)
        ] ?? null;

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
        recoveredIframeUrlRef.current = null;
        runtimeCommandWatermarkRef.current[message.runtimeInstanceId] = 0;
        applyRuntimeSnapshot(message, message.argOverrides);
        restoreSessionIntoRuntime(message);
        syncPreviewFeedbackThemeToRuntime(
          message.runtimeInstanceId,
          message.previewFileRelativePath,
        );
        syncPreviewFeedbackToRuntime();
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
        if (isDynamicImportFetchErrorMessage(message.message)) {
          void recoverPreviewRuntimeOnce("dynamic-import");
          return;
        }
        patchProjectState(activeProjectRef, {
          runtimeState: {
            kind: "runtime.error",
            projectId: activeProjectRef.projectId,
            message: message.message,
          },
        });
        return;
      }

      if (
        event.data.kind === "preview.feedback.enabledChanged" &&
        typeof event.data.runtimeInstanceId === "string" &&
        typeof event.data.previewFileRelativePath === "string" &&
        typeof event.data.enabled === "boolean"
      ) {
        if (
          projectState?.currentPreviewFileRelativePath &&
          projectState.currentPreviewFileRelativePath !== event.data.previewFileRelativePath
        ) {
          return;
        }
        if (
          projectState?.runtimeSnapshot?.runtimeInstanceId &&
          projectState.runtimeSnapshot.runtimeInstanceId !== event.data.runtimeInstanceId
        ) {
          return;
        }
        setFeedbackEnabled(event.data.enabled);
        return;
      }

      if (
        event.data.kind === "preview.feedback.created" &&
        typeof event.data.runtimeInstanceId === "string" &&
        typeof event.data.previewFileRelativePath === "string" &&
        event.data.annotation &&
        typeof event.data.annotation === "object"
      ) {
        const message = event.data as PreviewFeedbackCreatedMessage;
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
        updateProjectState(activeProjectRef, (currentState) => ({
          ...currentState,
          sessionsByPreviewFilePath: upsertPreviewFileSession(
            currentState.sessionsByPreviewFilePath,
            message.previewFileRelativePath,
            (session) => ({
              ...session,
              feedbackAnnotations: [...session.feedbackAnnotations, message.annotation],
              updatedAt: new Date().toISOString(),
            }),
          ),
        }));
        return;
      }

      if (
        event.data.kind === "preview.feedback.submitRequested" &&
        typeof event.data.runtimeInstanceId === "string" &&
        typeof event.data.previewFileRelativePath === "string"
      ) {
        if (
          projectState?.currentPreviewFileRelativePath &&
          projectState.currentPreviewFileRelativePath !== event.data.previewFileRelativePath
        ) {
          return;
        }
        if (
          projectState?.runtimeSnapshot?.runtimeInstanceId &&
          projectState.runtimeSnapshot.runtimeInstanceId !== event.data.runtimeInstanceId
        ) {
          return;
        }
        void openPreviewFeedbackThread();
        return;
      }

      if (
        event.data.kind === "preview.feedback.clearRequested" &&
        typeof event.data.runtimeInstanceId === "string" &&
        typeof event.data.previewFileRelativePath === "string"
      ) {
        if (
          projectState?.currentPreviewFileRelativePath &&
          projectState.currentPreviewFileRelativePath !== event.data.previewFileRelativePath
        ) {
          return;
        }
        if (
          projectState?.runtimeSnapshot?.runtimeInstanceId &&
          projectState.runtimeSnapshot.runtimeInstanceId !== event.data.runtimeInstanceId
        ) {
          return;
        }
        updateProjectState(activeProjectRef, (currentState) => ({
          ...currentState,
          sessionsByPreviewFilePath: upsertPreviewFileSession(
            currentState.sessionsByPreviewFilePath,
            event.data.previewFileRelativePath,
            (session) => ({
              ...session,
              feedbackAnnotations: session.feedbackAnnotations.filter(
                (annotation) =>
                  buildPreviewFeedbackScopeKey(annotation.scope) !==
                  buildPreviewFeedbackScopeKey(activeFeedbackScope),
              ),
              updatedAt: new Date().toISOString(),
            }),
          ),
        }));
      }
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeProjectRef,
    activeProjectRef?.projectId,
    applyRuntimeSnapshot,
    patchProjectState,
    recoverPreviewRuntimeOnce,
    restoreSessionIntoRuntime,
    syncPreviewFeedbackThemeToRuntime,
    syncPreviewFeedbackToRuntime,
    updateProjectState,
    activeFeedbackScope,
  ]);

  useEffect(() => {
    if (!iframeUrl || runtimeSnapshot?.runtimeInstanceId) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void recoverPreviewRuntimeOnce("timeout");
    }, 8_000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [iframeUrl, recoverPreviewRuntimeOnce, runtimeSnapshot?.runtimeInstanceId]);

  useEffect(() => {
    syncPreviewViewportToRuntime();
  }, [syncPreviewViewportToRuntime]);

  useEffect(() => {
    syncPreviewFeedbackToRuntime();
  }, [syncPreviewFeedbackToRuntime]);

  useEffect(() => {
    const canvasElement = previewCanvasRef.current;
    if (!canvasElement) {
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      setPreviewCanvasSize((currentSize) =>
        Math.abs(currentSize.width - width) < 0.5 && Math.abs(currentSize.height - height) < 0.5
          ? currentSize
          : { width, height },
      );
    });
    resizeObserver.observe(canvasElement);
    return () => {
      resizeObserver.disconnect();
    };
  }, [iframeUrl]);

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

  useEffect(() => {
    if (
      !activeProjectRef ||
      !resolved ||
      shouldUseDirectIframe ||
      activeProjectState?.accessToken
    ) {
      return;
    }
    let cancelled = false;
    void issueAccessTokenCommand({
      environmentId: activeProjectRef.environmentId,
      input: { projectId: activeProjectRef.projectId },
    }).then((result) => {
      if (cancelled) {
        return;
      }
      patchProjectState(activeProjectRef, {
        accessToken: result._tag === "Success" ? result.value.accessToken : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeProjectRef,
    activeProjectState?.accessToken,
    issueAccessTokenCommand,
    patchProjectState,
    resolved,
    shouldUseDirectIframe,
  ]);

  if (!activeProjectRef) {
    return (
      <div className="h-full overflow-auto px-4 py-4">
        <div className="text-sm font-semibold text-foreground">Component preview</div>
        <div className="mt-1 text-sm text-muted-foreground">
          Open a thread to preview components from its project here.
        </div>
      </div>
    );
  }

  const runtimeErrorResolution =
    activeProjectState?.resolution?.status === "runtimeError"
      ? activeProjectState.resolution
      : null;
  const runtimeErrorEvent =
    activeProjectState?.runtimeState?.kind === "runtime.error"
      ? activeProjectState.runtimeState
      : null;
  const hasFixedPreviewViewport = Boolean(previewViewport.width || previewViewport.height);
  const fixedPreviewViewportWidth = previewViewport.width ?? previewCanvasSize.width;
  const fixedPreviewViewportHeight = previewViewport.height ?? previewCanvasSize.height;
  const previewViewportScale =
    hasFixedPreviewViewport && fixedPreviewViewportWidth > 0 && fixedPreviewViewportHeight > 0
      ? (previewZoom.value ??
        Math.min(
          1,
          Math.max(0.1, (previewCanvasSize.width - 64) / fixedPreviewViewportWidth),
          Math.max(0.1, (previewCanvasSize.height - 64) / fixedPreviewViewportHeight),
        ))
      : 1;
  const scaledPreviewViewportWidth = fixedPreviewViewportWidth * previewViewportScale;
  const scaledPreviewViewportHeight = fixedPreviewViewportHeight * previewViewportScale;
  const previewViewportSlotStyle = hasFixedPreviewViewport
    ? {
        width: `${scaledPreviewViewportWidth}px`,
        height: `${scaledPreviewViewportHeight}px`,
      }
    : undefined;
  const previewViewportFrameStyle = hasFixedPreviewViewport
    ? {
        width: `${fixedPreviewViewportWidth}px`,
        height: `${fixedPreviewViewportHeight}px`,
        transform: `scale(${previewViewportScale})`,
        transformOrigin: "top left",
      }
    : undefined;
  const previewCanvasStyle = {
    backgroundColor: "var(--app-chrome-background, var(--background))",
    backgroundImage:
      "radial-gradient(circle, color-mix(in oklab, var(--foreground) 16%, transparent) 1px, transparent 1px)",
    backgroundPosition: "0 0",
    backgroundSize: "20px 20px",
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      <ComponentPreviewProjectEventsBridge projectRef={activeProjectRef} />
      <div className="absolute top-3 z-30 flex w-full items-center justify-between gap-1.5 px-4">
        {iframeUrl ? (
          <div className="flex items-center gap-1.5">
            <Popover>
              <PopoverTrigger
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background/88 px-2.5 text-xs text-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-accent"
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
          </div>
        ) : (
          <div />
        )}
        {activeProjectState?.currentRelativePath ? (
          <div className="inline-flex h-6 items-center overflow-hidden rounded-md border border-border/70 bg-background/88 shadow-sm backdrop-blur-md">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => void restartPreviewRuntime().then(refreshInspection)}
              aria-label="Refresh preview"
              title="Refresh preview"
            >
              <RefreshIcon className="size-3 fill-current" />
            </button>
          </div>
        ) : null}
      </div>

      {iframeUrl ? (
        <>
          <div className="pointer-events-none absolute bottom-3 left-4 z-30 flex items-center gap-1.5">
            <div className="pointer-events-auto flex items-center gap-1.5">
              <PreviewViewportControl
                selectedViewportId={previewViewportId}
                onSelectViewport={setPreviewViewportId}
              />
              <PreviewZoomControl selectedZoomId={previewZoomId} onSelectZoom={setPreviewZoomId} />
            </div>
          </div>

          <div className="pointer-events-none absolute bottom-3 right-4 z-30 flex items-center gap-1.5">
            <div
              className="pointer-events-auto inline-flex h-7 items-center overflow-visible rounded-md"
              style={previewChromePillStyle}
            >
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-none rounded-l-md border-0 bg-transparent transition-colors hover:bg-accent active:scale-[0.92]"
                style={previewChromeIconButtonStyle(feedbackEnabled)}
                onClick={() => setFeedbackEnabled((current) => !current)}
                aria-label="Annotate preview"
                title="Annotate preview"
              >
                <AnnotationIcon className="size-3.5 fill-current" />
              </button>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-none border-0 bg-transparent transition-colors hover:bg-accent active:scale-[0.92]"
                style={previewChromeIconButtonStyle(feedbackMarkersVisible)}
                onClick={() => setFeedbackMarkersVisible((current) => !current)}
                aria-label="Show feedback markers"
                title="Show feedback markers"
              >
                <PreviewFeedbackEyeIcon size={16} isOpen={feedbackMarkersVisible} />
              </button>
              <button
                type="button"
                className="relative inline-flex size-7 items-center justify-center rounded-none border-0 bg-transparent transition-colors hover:bg-accent active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-35"
                style={previewChromeIconButtonStyle(false)}
                disabled={unsentFeedbackCount === 0}
                onClick={() => void openPreviewFeedbackThread()}
                aria-label="Send feedback to agent"
                title="Send feedback to agent"
              >
                <SendFeedbackIcon className="size-3.5 fill-current" />
                {unsentFeedbackCount > 0 ? (
                  <span
                    className="pointer-events-none absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white"
                    style={{
                      backgroundColor: "var(--primary)",
                      boxShadow:
                        "0 0 0 2px var(--popover, var(--background)), 0 1px 3px color-mix(in srgb, var(--foreground) 20%, transparent)",
                    }}
                  >
                    {unsentFeedbackCount}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-none border-0 bg-transparent transition-colors hover:bg-accent active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-35"
                style={previewChromeIconButtonStyle(false)}
                disabled={activeFeedbackAnnotations.length === 0}
                onClick={() => {
                  if (!activeProjectRef || !activePreviewFileRelativePath) {
                    return;
                  }
                  updateProjectState(activeProjectRef, (currentState) => ({
                    ...currentState,
                    sessionsByPreviewFilePath: upsertPreviewFileSession(
                      currentState.sessionsByPreviewFilePath,
                      activePreviewFileRelativePath,
                      (session) => ({
                        ...session,
                        feedbackAnnotations: session.feedbackAnnotations.filter(
                          (annotation) =>
                            buildPreviewFeedbackScopeKey(annotation.scope) !==
                            buildPreviewFeedbackScopeKey(activeFeedbackScope),
                        ),
                        updatedAt: new Date().toISOString(),
                      }),
                    ),
                  }));
                }}
                aria-label="Clear feedback"
                title="Clear feedback"
              >
                <SidebarArchiveIcon className="size-3.5" />
              </button>
            </div>
          </div>
        </>
      ) : null}

      <div className="h-full min-h-0 overflow-auto">
        {activeProjectState?.resolution?.status === "needsBootstrap" ? (
          <div className="flex h-full items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-border/70 bg-card/80 p-4 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <PreviewIcon className="size-4 fill-current" />
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
                <IconSparkles className="size-4 fill-current" />
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
              <p className="mt-2 text-sm text-muted-foreground">{runtimeErrorResolution.message}</p>
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
              This file could not be found in the current project workspace.
            </div>
          </div>
        ) : iframeUrl ? (
          <div
            ref={previewCanvasRef}
            className="h-full min-h-0 overflow-auto"
            style={previewCanvasStyle}
          >
            <div
              className={
                hasFixedPreviewViewport
                  ? "grid h-full min-h-full w-full place-items-center p-8"
                  : "h-full min-h-full w-full"
              }
            >
              <div
                className={
                  hasFixedPreviewViewport
                    ? "overflow-hidden rounded-lg"
                    : "h-full w-full bg-transparent"
                }
                style={previewViewportSlotStyle}
              >
                <div
                  className={
                    hasFixedPreviewViewport ? "bg-transparent" : "h-full w-full bg-transparent"
                  }
                  style={previewViewportFrameStyle}
                >
                  <iframe
                    ref={iframeRef}
                    key={`${resolved?.iframePath ?? "preview"}:${previewFrameReloadNonce}`}
                    className="block h-full w-full bg-transparent"
                    sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                    src={iframeUrl}
                    style={{ backgroundColor: "transparent" }}
                    title="Component preview canvas"
                  />
                </div>
              </div>
            </div>
          </div>
        ) : activeProjectState?.currentRelativePath &&
          (!resolved || (!shouldUseDirectIframe && !activeProjectState.accessToken)) ? (
          <div className="flex h-full min-h-[18rem] items-center justify-center text-sm text-muted-foreground">
            {resolved ? "Authorizing preview…" : "Resolving preview…"}
          </div>
        ) : (
          <div className="flex h-full min-h-[18rem] flex-col items-center justify-center gap-4 p-4">
            <div className="text-sm text-muted-foreground">
              Pick a component file from this project to render it here.
            </div>
            <ComponentPreviewTargetPicker projectRef={activeProjectRef} />
          </div>
        )}
      </div>
    </div>
  );
}

function readThreadShellForRef(projectRef: ScopedProjectRef, threadId: ThreadId) {
  return readThreadShell(scopeThreadRef(projectRef.environmentId, threadId));
}
