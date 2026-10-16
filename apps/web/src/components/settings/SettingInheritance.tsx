import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_FILE_BACKED_SETTINGS,
  type ProjectFileBackedSettingKey,
  resolveEnvironmentMachineKind,
  type ServerSettings,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, LayersIcon } from "lucide-react";
import * as Equal from "effect/Equal";

import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import type { ProjectOverrideEntry, ScopedSettingsTarget } from "./scopedSettings";
import { isProjectScopedSettingKey } from "./scopedSettings";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

interface InheritanceLayer {
  readonly key: "project" | "environment" | "t3.json" | "built-in";
  readonly label: string;
  readonly value: string;
  readonly effective: boolean;
  readonly set: boolean;
}

const WRITING_STYLE_LABELS: Record<string, string> = {
  repo_conventions: "Repository conventions",
  conventional_commits: "Conventional Commits",
  custom: "Custom instructions",
};

/** Human labels for the values the chain can show; falls back to a type summary. */
function formatValue(key: keyof ServerSettings, value: unknown): string {
  if (value === null || value === undefined) {
    return key === "pullRequestMergeMethod"
      ? "Last selected"
      : key === "sidebarAutoSettleAfterDays"
        ? "Never"
        : key === "defaultModelSelection"
          ? "Automatic"
          : key === "sourceControlWriterModelSelection"
            ? "Text generation model"
            : key === "reviewGuideModelSelection"
              ? "Source control writer model"
              : key === "defaultThreadEnvMode" || key === "worktreeSubmodules"
                ? "Inherit"
                : "Not set";
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    return key === "sidebarAutoSettleAfterDays"
      ? `${value} ${value === 1 ? "day" : "days"}`
      : String(value);
  }
  if (typeof value === "string") {
    if (key === "defaultThreadEnvMode" && (value === "local" || value === "worktree")) {
      return resolveEnvModeLabel(value);
    }
    if (key === "worktreeSubmodules" && value in WORKTREE_SUBMODULES_LABELS) {
      return WORKTREE_SUBMODULES_LABELS[value as WorktreeSubmodules];
    }
    if (key === "pullRequestMergeMethod" && value in PULL_REQUEST_MERGE_METHOD_LABELS) {
      return PULL_REQUEST_MERGE_METHOD_LABELS[
        value as keyof typeof PULL_REQUEST_MERGE_METHOD_LABELS
      ];
    }
    return value === "" ? "Empty" : value;
  }
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (typeof value === "object") {
    if ("model" in value && typeof value.model === "string") return value.model;
    if ("mode" in value && typeof value.mode === "string") {
      return WRITING_STYLE_LABELS[value.mode] ?? value.mode;
    }
  }
  return "Custom";
}

/**
 * The layers a setting resolves through for one target, top-down: the
 * project override when the target is a project, the environment's value,
 * the checkout's t3.json for file-backed keys, and the built-in default. The
 * first layer that is set wins. Same order as `resolveProjectSettings`.
 */
export function settingInheritanceLayers(
  target: ScopedSettingsTarget,
  environmentSettings: ServerSettings,
  key: keyof ServerSettings,
): readonly InheritanceLayer[] {
  const environmentValue = environmentSettings[key];
  const source = isProjectScopedSettingKey(key) ? target.sources[key] : "environment";
  const environmentSet = !Equal.equals(environmentValue, DEFAULT_SERVER_SETTINGS[key]);
  const fileBacked = isProjectFileBackedSettingKey(key);
  const layers: InheritanceLayer[] = [];
  if (target.projectId !== null && isProjectScopedSettingKey(key)) {
    layers.push({
      key: "project",
      label: "Project",
      value: source === "project" ? formatValue(key, target.settings[key]) : "Inherits",
      effective: source === "project",
      set: source === "project",
    });
  }
  layers.push({
    key: "environment",
    label: target.label,
    value: environmentSet ? formatValue(key, environmentValue) : "Inherits",
    effective: source === "environment" && environmentSet,
    set: environmentSet,
  });
  if (fileBacked && target.projectId !== null) {
    layers.push({
      key: "t3.json",
      label: "t3.json",
      value: source === "t3.json" ? formatValue(key, target.settings[key]) : "Inherits",
      effective: source === "t3.json",
      set: source === "t3.json",
    });
  }
  // For a file-backed key the built-in is what the resolver produced with
  // nothing set, not the null the schema decodes to.
  const builtIn = fileBacked
    ? PROJECT_FILE_BACKED_SETTINGS[key].builtIn
    : DEFAULT_SERVER_SETTINGS[key];
  layers.push({
    key: "built-in",
    label: "Default",
    value: formatValue(key, builtIn),
    effective: source === "environment" && !environmentSet,
    set: true,
  });
  return layers;
}

function isProjectFileBackedSettingKey(
  key: keyof ServerSettings,
): key is ProjectFileBackedSettingKey {
  return Object.hasOwn(PROJECT_FILE_BACKED_SETTINGS, key);
}

export type SettingInheritanceState =
  | "default"
  | "environment"
  | "inherited"
  | "overridden"
  | "mixed";

/**
 * A small indicator beside a row's title that opens a top-down view of where
 * the setting's value comes from on each selected target. It sits inline so
 * narrowing to a project does not add a caption line to every row.
 */
export interface SettingOverridingProject extends ProjectOverrideEntry {
  readonly label: string;
  /** Jumps the breadcrumb to this project so its override can be edited. */
  readonly open: () => void;
}

export function SettingInheritance({
  state,
  summary,
  targets,
  environments,
  keys,
  overridingProjects = [],
  onClearOverrides,
}: {
  state: SettingInheritanceState;
  summary: string;
  targets: readonly ScopedSettingsTarget[];
  environments: readonly Pick<
    EnvironmentPresentation,
    "environmentId" | "label" | "displayUrl" | "serverConfig"
  >[];
  keys: readonly (keyof ServerSettings)[];
  /** At environment scope: projects whose own value hides the environment's. */
  overridingProjects?: readonly SettingOverridingProject[];
  onClearOverrides?: (entries: readonly ProjectOverrideEntry[]) => void;
}) {
  const scopeContext = useOptionalSettingsScope();
  const key = keys[0];
  if (!key || targets.length === 0) return null;
  const hasMultipleEnvironments = new Set(targets.map((target) => target.environmentId)).size > 1;
  const overrideSummary =
    overridingProjects.length > 0
      ? `${summary} · ${overridingProjects.length} project ${overridingProjects.length === 1 ? "override" : "overrides"}`
      : summary;
  const chains = targets.flatMap((target) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === target.environmentId,
    );
    if (!environment?.serverConfig) return [];
    const labels = settingsScopeEnvironmentLabels(environment, environments);
    const path = scopeContext?.scope.members.find(
      (member) => member.environmentId === target.environmentId && member.id === target.projectId,
    )?.workspaceRoot;
    const secondary = [labels.secondary, path?.split(/[\\/]/).filter(Boolean).slice(-2).join("/")]
      .filter(Boolean)
      .join(" · ");
    const layers = settingInheritanceLayers(target, environment.serverConfig.settings, key);
    const winningLayer = layers.find((layer) => layer.effective);
    return [
      {
        id: `${target.environmentId}:${target.projectId ?? ""}`,
        target,
        label: [labels.primary, secondary].filter(Boolean).join(" · "),
        machineLabel: [labels.primary, labels.secondary].filter(Boolean).join(" · "),
        overrides: environment.serverConfig.settings.projectSettingsOverrides,
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
        layers,
        winningLayer,
        resolution: {
          winner: winningLayer?.key,
          layers: layers.map(({ key, value }) => [key, value]),
          settings: keys.map((settingKey) => target.settings[settingKey]),
        },
      },
    ];
  });
  const primary =
    chains.find(
      ({ target }) =>
        target.environmentId === scopeContext?.target?.environmentId &&
        target.projectId === scopeContext?.target?.projectId,
    ) ?? chains[0];
  const machineLabelFor = (environmentId: string) =>
    chains.find((entry) => entry.target.environmentId === environmentId)?.machineLabel ?? "";
  const groups: (typeof chains)[] = [];
  for (const chain of hasMultipleEnvironments && primary
    ? [primary, ...chains.filter((entry) => entry !== primary)]
    : chains) {
    const group =
      hasMultipleEnvironments &&
      groups.find(([first]) => first && Equal.equals(first.resolution, chain.resolution));
    if (group) group.push(chain);
    else groups.push([chain]);
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`${overrideSummary}. Show where this value comes from`}
                />
              }
            />
          }
        >
          <LayersIcon
            className={cn(
              "size-3",
              state === "overridden" && "text-primary",
              state === "mixed" && "text-warning",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{overrideSummary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" width="md" padding="none">
        <div className="divide-y divide-border/60">
          {groups.map((members) => {
            const first = members[0];
            if (!first) return null;
            const { id, target, machine, layers, winningLayer } = first;
            const chain = (
              <ol role="list" className="text-sm">
                {layers.map((layer) => (
                  <li
                    key={layer.key}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
                      layer.effective && "bg-foreground/[0.06]",
                    )}
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {layer.key === "environment" ? "Environment" : layer.label}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 tabular-nums",
                        layer.effective
                          ? "text-foreground"
                          : layer.set
                            ? "text-muted-foreground"
                            : "text-muted-foreground/60",
                      )}
                    >
                      <span className="max-w-32 truncate">{layer.value}</span>
                      {layer.effective ? (
                        <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <span aria-hidden className="size-3.5 shrink-0" />
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            );
            return (
              <section key={id} className="px-3 py-2.5">
                {!hasMultipleEnvironments ? (
                  <h4 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted-foreground">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={machine}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">{target.label}</span>
                  </h4>
                ) : null}
                {hasMultipleEnvironments && groups.length > 1 ? (
                  <Collapsible>
                    <CollapsibleTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm-multiline"
                          className="w-full justify-start text-left"
                        />
                      }
                    >
                      <span className="flex w-full min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground tabular-nums">
                            {winningLayer?.value}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {winningLayer?.key === "environment"
                              ? "Environment"
                              : winningLayer?.label}
                          </span>
                          <ChevronRightIcon
                            aria-hidden
                            className="size-3 shrink-0 text-muted-foreground [[data-panel-open]_&]:rotate-90"
                          />
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                          {members.map((member) => (
                            <span
                              key={member.id}
                              className="flex min-w-0 max-w-full items-center gap-1"
                            >
                              <EnvironmentMachineIcon
                                aria-hidden
                                kind={member.machine}
                                className="size-3 shrink-0"
                              />
                              <span className="truncate">{member.label}</span>
                            </span>
                          ))}
                        </span>
                      </span>
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div className="pt-1.5">{chain}</div>
                    </CollapsiblePanel>
                  </Collapsible>
                ) : (
                  <>
                    {chain}
                    {hasMultipleEnvironments ? (
                      <p className="px-2 pt-1.5 text-xs text-muted-foreground">
                        Same on all machines
                      </p>
                    ) : null}
                  </>
                )}
                {(() => {
                  const overriding = overridingProjects.filter((project) =>
                    members.some((member) => member.target.environmentId === project.environmentId),
                  );
                  if (overriding.length === 0) return null;
                  const foldOverrides = hasMultipleEnvironments && overriding.length > 3;
                  const header = (
                    <div className="flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
                      {foldOverrides ? (
                        <CollapsibleTrigger render={<InlineButton tone="muted" />}>
                          <ChevronRightIcon
                            aria-hidden
                            className="size-3 [[data-panel-open]_&]:rotate-90"
                          />
                          Overridden by
                        </CollapsibleTrigger>
                      ) : (
                        <span>Overridden by</span>
                      )}
                      {onClearOverrides ? (
                        <InlineButton onClick={() => onClearOverrides(overriding)}>
                          Reset {overriding.length === 1 ? "it" : "all"}
                        </InlineButton>
                      ) : null}
                    </div>
                  );
                  const projects = (
                    <ul
                      role="list"
                      className={cn("mt-0.5 text-sm", foldOverrides && "max-h-48 overflow-y-auto")}
                    >
                      {overriding.map((project) => (
                        <li
                          key={`${project.environmentId}:${project.projectId}`}
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2 py-1"
                        >
                          <span className="flex min-w-0 flex-col items-start">
                            <InlineButton
                              className="min-w-0 max-w-full justify-start"
                              onClick={project.open}
                            >
                              <span className="truncate">{project.label}</span>
                            </InlineButton>
                            {hasMultipleEnvironments ? (
                              <span className="max-w-full truncate text-xs text-muted-foreground">
                                {machineLabelFor(project.environmentId)}
                              </span>
                            ) : null}
                          </span>
                          <span className="max-w-32 truncate text-muted-foreground tabular-nums">
                            {isProjectScopedSettingKey(key)
                              ? formatValue(
                                  key,
                                  members.find(
                                    (member) =>
                                      member.target.environmentId === project.environmentId,
                                  )?.overrides[project.projectId]?.[key],
                                )
                              : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  );
                  return (
                    <div className="mt-2 border-t border-border/60 pt-2">
                      {foldOverrides ? (
                        <Collapsible>
                          {header}
                          <CollapsiblePanel>{projects}</CollapsiblePanel>
                        </Collapsible>
                      ) : (
                        <>
                          {header}
                          {projects}
                        </>
                      )}
                    </div>
                  );
                })()}
              </section>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
