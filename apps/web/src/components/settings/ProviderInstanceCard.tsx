import { SettingsGroup } from "./SettingsGroup";
import { Text } from "../ui/text";
import { Spinner } from "~/components/ui/spinner";

import {
  AlertTriangleIcon,
  CheckIcon,
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LayersIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
  LockIcon,
  LockOpenIcon,
} from "lucide-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { Fragment, useId, useState, type ReactElement, type ReactNode } from "react";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  isProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type AcpRegistryUrlAuthAction,
  type EnvironmentId,
  type ProjectId,
  type ProviderDriverKind,
  type SecretReference,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  type CustomModelDefinition,
  readCustomModelEntries,
  toCustomModelSetting,
} from "@t3tools/shared/model";
import { cn } from "../../lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useStableCallback } from "../../hooks/useStableCallback";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SecretSourceInput, type SecretSource } from "./SecretSourceInput";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { StatusDot } from "../ui/status-dot";
import { Switch } from "../ui/switch";
import { ManagedControl, ManagedNotice } from "../ManagedPolicy";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { disallowedProviderMessage, isManagedDriverAllowed } from "@t3tools/contracts";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type {
  ProviderClientDefinition,
  ProviderEnvironmentField,
} from "@t3tools/provider-core/client";
import {
  deriveProviderSettingsFields,
  ProviderSettingsForm,
  reconcileRowsDraft,
  seedRowsDraft,
} from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import { UsageAccessReads } from "../usage/UsageAccessReads";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { AcpSessionManagementSection } from "./AcpSessionManagementSection";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import {
  type CustomModelSave,
  customModelsKey,
  pendingCustomModelSaves,
  settleCustomModelSave,
} from "./customModelSaves.logic";
import { getProviderRestartNotice } from "../ProviderUpdateLaunchNotification.logic";
import {
  getProviderReinstallCommand,
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderStatusKey,
  getProviderSummary,
  getProviderVersionLabel,
  providerAuthLabel,
} from "./providerStatus";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ProviderStatusDiagnostic({
  detail,
  children,
}: {
  detail: ReactNode;
  children: ReactElement;
}) {
  if (!detail) return children;
  return <SharedTooltipTrigger render={children} label={detail} />;
}

const ENVIRONMENT_VARIABLE_NAME_PLACEHOLDER = "VARIABLE_NAME";

let environmentVariableDraftId = 0;
const DRAFT_ROW_ID_PREFIX = "provider-env-";
const nextEnvironmentVariableDraftId = () =>
  `${DRAFT_ROW_ID_PREFIX}${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: ProviderInstanceEnvironmentVariable["value"];
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

const toEnvironmentDraftRows = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) =>
  environment.map(makeEnvironmentDraftRow);

function environmentValuesEqual(
  left: ProviderInstanceEnvironmentVariable["value"],
  right: ProviderInstanceEnvironmentVariable["value"],
): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.provider === right.provider && left.reference === right.reference;
}

function providerEnvironmentsEqual(
  left: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  right: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): boolean {
  return (
    left.length === right.length &&
    left.every((variable, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        variable.name === other.name &&
        environmentValuesEqual(variable.value, other.value) &&
        variable.sensitive === other.sensitive &&
        variable.valueRedacted === other.valueRedacted
      );
    })
  );
}

function readConfigString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Preserve explicit empty arrays/objects; clearing a custom list differs from selecting driver defaults. */
function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const serverSlugs = new Set(serverModels.map((model) => model.slug));
  const customModels = input.customModels.flatMap((entry) =>
    serverSlugs.has(entry.slug)
      ? []
      : [
          {
            slug: entry.slug,
            name: entry.name,
            isCustom: true,
            capabilities:
              entry.capabilities ?? liveCustomModelsBySlug.get(entry.slug)?.capabilities ?? null,
          },
        ],
  );
  return [...serverModels, ...customModels];
}

function ProviderAuthEmail(props: { readonly email: string | undefined }) {
  const gt = useGT();
  const email = props.email?.trim();
  if (!email) return null;

  return (
    <RedactedSensitiveText
      value={email}
      ariaLabel={gt("Toggle account email visibility")}
      revealTooltip={gt("Click to reveal email")}
      hideTooltip={gt("Click to hide email")}
      className="pointer-events-auto max-w-full truncate"
    />
  );
}

type ProviderVersionAdvisory = NonNullable<
  ReturnType<typeof getProviderVersionAdvisoryPresentation>
>;

// The popover and the Status row both offer the same update action, so the
// label, busy state and progress line live in one place.
function ProviderVersionUpdateAction(props: {
  readonly advisory: ProviderVersionAdvisory;
  readonly isReinstall: boolean;
  readonly isUpdating: boolean;
  readonly progress: string | null;
  readonly problem: string | null;
  readonly stretch: boolean;
  readonly onRun: () => void;
}) {
  const { advisory, isReinstall, isUpdating, progress, problem, stretch, onRun } = props;
  const gt = useGT();
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="secondary"
        className={cn(stretch ? "w-full" : "w-fit")}
        disabled={isUpdating}
        onClick={onRun}
      >
        {isUpdating ? <Spinner /> : <DownloadIcon />}
        {isUpdating
          ? gt("Updating")
          : advisory.targetVersion
            ? gt("Install {version}", {
                version: getProviderVersionLabel(advisory.targetVersion),
              })
            : isReinstall
              ? gt("Reinstall")
              : gt("Update now")}
      </Button>
      {progress || problem ? (
        <p
          aria-live="polite"
          className={cn(
            "text-xs leading-snug [overflow-wrap:anywhere]",
            problem ? "text-warning" : "text-muted-foreground",
          )}
        >
          {progress ?? problem}
        </p>
      ) : null}
    </>
  );
}

function readProviderEnvironmentVariable(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  name: string,
): ProviderInstanceEnvironmentVariable | undefined {
  return environment?.find((variable) => variable.name === name);
}

function providerEnvironmentWithoutNames(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  names: ReadonlySet<string>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return (environment ?? []).filter((variable) => !names.has(variable.name));
}

export function nextProviderEnvironmentWithFieldValue(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  field: ProviderEnvironmentField,
  value: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const trimmed = value.trim();
  const next: ProviderInstanceEnvironmentVariable[] = [];
  let found = false;

  for (const variable of environment ?? []) {
    if (variable.name !== field.name) {
      next.push(variable);
      continue;
    }
    found = true;
    if (trimmed.length > 0) {
      next.push({
        name: variable.name,
        value: trimmed,
        sensitive: field.sensitive ?? true,
      });
    }
  }

  if (!found && trimmed.length > 0) {
    next.push({
      name: field.name,
      value: trimmed,
      sensitive: field.sensitive ?? true,
    });
  }

  return next;
}

export function nextProviderEnvironmentWithFieldSecret(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  field: ProviderEnvironmentField,
  secret: SecretReference | undefined,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const others = providerEnvironmentWithoutNames(environment, new Set([field.name]));
  return secret === undefined
    ? others
    : [...others, { name: field.name, value: secret, sensitive: true }];
}

function ProviderEnvironmentFieldRow(props: {
  readonly field: ProviderEnvironmentField;
  readonly variable: ProviderInstanceEnvironmentVariable | undefined;
  readonly idPrefix: string;
  readonly onCommit: (field: ProviderEnvironmentField, value: string) => void;
  readonly onSecretChange: (
    field: ProviderEnvironmentField,
    secret: SecretReference | undefined,
  ) => void;
  readonly onRemove: (field: ProviderEnvironmentField) => void;
  readonly managedReason?: string | undefined;
  readonly secretSources: ReadonlyArray<SecretSource>;
  readonly environmentId?: EnvironmentId | undefined;
}) {
  const gt = useGT();
  const id = useId();
  const inputId = `${props.idPrefix}-${id}-environment-${props.field.name}`;
  const value = props.variable?.valueRedacted ? "" : (props.variable?.value ?? "");

  return (
    <SettingsRow
      title={<label htmlFor={inputId}>{props.field.label}</label>}
      description={props.field.description}
      managed={props.managedReason}
      control={
        <div className="flex w-full min-w-0 items-center gap-2 @min-[26rem]/settings-row:w-56">
          {props.field.sensitive === false ? (
            <DraftInput
              id={inputId}
              size="settings"
              className="min-w-0 flex-1"
              autoComplete="off"
              value={typeof value === "string" ? value : ""}
              onCommit={(next) => props.onCommit(props.field, next)}
              placeholder={props.field.placeholder}
              spellCheck={false}
            />
          ) : (
            <SecretSourceInput
              id={inputId}
              size="settings"
              className="min-w-0 flex-1"
              value={value}
              onCommit={(next) => props.onCommit(props.field, next)}
              placeholder={props.field.placeholder}
              configured={props.variable?.valueRedacted === true}
              spellCheck={false}
              aria-label={props.field.label}
              sources={props.secretSources}
              environmentId={props.environmentId}
              onSecretChange={(secret) => props.onSecretChange(props.field, secret)}
            />
          )}
          {props.variable ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-destructive"
              onClick={() => props.onRemove(props.field)}
              aria-label={gt("Clear {field}", { field: props.field.label })}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

export function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
  /** Variables an administrator's policy pins: listed by name, never editable or removable. */
  readonly managed?: { readonly names: ReadonlySet<string>; readonly reason: string } | undefined;
  readonly secretSources?: ReadonlyArray<SecretSource>;
  readonly environmentId?: EnvironmentId | undefined;
}) {
  const gt = useGT();
  const [storedDraft, setDraft] = useState(() =>
    seedRowsDraft(props.environment, toEnvironmentDraftRows),
  );
  let draft = reconcileRowsDraft(
    storedDraft,
    props.environment,
    providerEnvironmentsEqual,
    toEnvironmentDraftRows,
  );
  if (draft.rows !== storedDraft.rows) {
    // Keep rows the server never acknowledged, even across an external reseed.
    const acknowledged = new Set(storedDraft.seen.map((variable) => variable.name));
    const unpublished = storedDraft.rows.filter(
      (row) =>
        row.id.startsWith(DRAFT_ROW_ID_PREFIX) &&
        !acknowledged.has(row.name) &&
        !draft.rows.some((incoming) => incoming.name === row.name),
    );
    if (unpublished.length > 0) draft = { ...draft, rows: [...draft.rows, ...unpublished] };
  }
  if (draft !== storedDraft) setDraft(draft);
  const rows = draft.rows;
  const setRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) =>
    setDraft({ ...draft, rows: nextRows });

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value !== "" ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    setDraft({ rows: nextRows, seen: draft.seen, lastPublished: published });
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    // A row named like a pinned variable renders as the policy's, with no way to edit or remove it.
    if (patch.name !== undefined && props.managed?.names.has(patch.name)) return;
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const setVariableSecret = (id: string, secret: SecretReference | undefined) => {
    const nextRows = rows.map((row) => {
      if (row.id !== id) return row;
      const { valueRedacted: _valueRedacted, ...rest } = row;
      return { ...rest, value: secret ?? "" };
    });
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  const addVariable = () =>
    setRows([
      ...rows,
      {
        id: nextEnvironmentVariableDraftId(),
        name: "",
        value: "",
        sensitive: true,
      },
    ]);

  return (
    <SettingsRow
      title={gt("Variables")}
      description={gt("API keys, base URLs, and other per-instance CLI settings.")}
      control={
        <Button type="button" size="sm" variant="secondary" onClick={addVariable}>
          <PlusIcon className="size-3" />
          <T>Add variable</T>
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((variable, index) => {
            if (props.managed?.names.has(variable.name)) {
              return (
                <div key={variable.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <code className="min-w-0 truncate text-meta sm:w-44 sm:shrink-0">
                    {variable.name}
                  </code>
                  <span className="text-meta text-muted-foreground">{props.managed.reason}</span>
                </div>
              );
            }
            const nameInput = (
              <DraftInput
                size="sm"
                font="mono"
                className="min-w-0 flex-1"
                value={variable.name}
                onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                disabled={variable.valueRedacted === true}
                placeholder={ENVIRONMENT_VARIABLE_NAME_PLACEHOLDER}
                spellCheck={false}
                aria-label={gt("Environment variable name {number}", { number: index + 1 })}
              />
            );
            const removeButton = (
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() => removeVariable(variable.id)}
                aria-label={gt("Remove environment variable {name}", {
                  name: variable.name || index + 1,
                })}
              >
                <XIcon className="size-3" />
              </Button>
            );
            const sensitiveToggle =
              typeof variable.value === "string" ? (
                <SharedTooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      disabled={variable.valueRedacted === true}
                      onClick={() => {
                        const sensitive = !variable.sensitive;
                        updateVariable(variable.id, {
                          sensitive,
                          ...(sensitive && variable.valueRedacted === undefined
                            ? {}
                            : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                        });
                      }}
                      aria-pressed={variable.sensitive}
                      aria-label={gt("Mark environment variable {name} as sensitive", {
                        name: variable.name || index + 1,
                      })}
                    >
                      {variable.sensitive ? (
                        <LockIcon className="size-3" />
                      ) : (
                        <LockOpenIcon className="size-3" />
                      )}
                    </Button>
                  }
                  label={variable.sensitive ? gt("Sensitive, stored separately") : gt("Plain text")}
                />
              ) : null;
            const layout = (source: ReactNode, value: ReactNode) => (
              <div className="flex min-w-0 flex-col gap-1.5 rounded-control surface-well p-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {nameInput}
                  {source}
                  {removeButton}
                </div>
                <div className="flex min-w-0 items-start gap-1.5">
                  {value}
                  {sensitiveToggle}
                </div>
              </div>
            );
            return (
              <Fragment key={variable.id}>
                {variable.sensitive ? (
                  <SecretSourceInput
                    size="sm"
                    font="mono"
                    className="min-w-0 flex-1"
                    value={variable.valueRedacted ? "" : variable.value}
                    onCommit={(value) => updateVariable(variable.id, { value })}
                    placeholder={gt("value", {
                      $context: "placeholder for an environment variable value",
                    })}
                    configured={variable.valueRedacted === true}
                    spellCheck={false}
                    aria-label={gt("Environment variable value {number}", { number: index + 1 })}
                    sources={props.secretSources ?? []}
                    environmentId={props.environmentId}
                    onSecretChange={(secret) => setVariableSecret(variable.id, secret)}
                  >
                    {(parts) => layout(parts.source, parts.value)}
                  </SecretSourceInput>
                ) : (
                  layout(
                    null,
                    <DraftInput
                      size="sm"
                      font="mono"
                      className="min-w-0 flex-1"
                      value={
                        variable.valueRedacted || typeof variable.value !== "string"
                          ? ""
                          : variable.value
                      }
                      onCommit={(value) => updateVariable(variable.id, { value })}
                      autoComplete="off"
                      placeholder={gt("value", {
                        $context: "placeholder for an environment variable value",
                      })}
                      spellCheck={false}
                      aria-label={gt("Environment variable value {number}", { number: index + 1 })}
                    />,
                  )
                )}
              </Fragment>
            );
          })}
          <p className="text-meta text-muted-foreground">
            {rows.some((row) => row.valueRedacted === true)
              ? gt(
                  "Sensitive values are stored separately and never returned to the app. Enter a new value to rename a saved one or make it plain text.",
                )
              : gt("Sensitive values are stored separately and never returned to the app.")}
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function ProjectOverrideInheritance({
  projectEnabled,
  deviceEnabled,
}: {
  readonly projectEnabled: boolean;
  readonly deviceEnabled: boolean;
}) {
  const gt = useGT();
  const layers = [
    {
      key: "project",
      label: gt("Project", { $context: "settings layer" }),
      enabled: projectEnabled,
      effective: true,
    },
    {
      key: "device",
      label: gt("Device", { $context: "settings layer" }),
      enabled: deviceEnabled,
      effective: false,
    },
  ];
  return (
    <Popover>
      <SharedTooltipTrigger
        render={
          <PopoverTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={gt("Overridden for this project. Show where this value comes from")}
              />
            }
          />
        }
        label={
          <>
            <T>Overridden for this project</T>
          </>
        }
      >
        <LayersIcon className="size-3 text-primary" />
      </SharedTooltipTrigger>
      <PopoverPopup align="end" width="md" padding="none">
        <ol role="list" className="px-3 py-2.5 text-sm">
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
                {layer.label}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5",
                  layer.effective ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {layer.enabled
                  ? gt("On", { $context: "setting state" })
                  : gt("Off", { $context: "setting state" })}
                {layer.effective ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
                ) : (
                  <span aria-hidden className="size-3.5 shrink-0" />
                )}
              </span>
            </li>
          ))}
        </ol>
      </PopoverPopup>
    </Popover>
  );
}

interface ProjectOverrideControl {
  readonly value: boolean | undefined;
  readonly effectiveEnabled: boolean;
  readonly onChange: (next: boolean) => void;
  readonly onReset: () => void;
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: ProviderClientDefinition | undefined;
  readonly liveProvider: ServerProvider | undefined;
  /** "list" is the compact row in the providers list; "editor" is the selected instance's detail. */
  readonly mode: "list" | "editor";
  readonly selected?: boolean;
  /** List cards open the full editor (a sheet) from the title or the menu. */
  readonly onConfigure?: (() => void) | undefined;
  /** List cards offer "Reset to defaults" for dirty built-in slots. */
  readonly readOnly?: boolean | undefined;
  readonly canWriteSettings?: boolean;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => Promise<boolean>;
  readonly onDelete?: (() => void) | undefined;
  readonly headerAction?: ReactNode | undefined;
  readonly setup?: ReactNode;
  readonly runtime?: ReactNode;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (
    next: ReadonlyArray<string>,
    affectedModels: ReadonlyArray<string>,
  ) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onToggleFavorite: (model: string) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly onInstallRecommended?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
  readonly onAcceptUrlAuth?: ((action: AcpRegistryUrlAuthAction) => void) | undefined;
  readonly environmentId?: EnvironmentId | undefined;
  readonly secretSources?: ReadonlyArray<SecretSource>;
  readonly projectOverride?: ProjectOverrideControl | undefined;
  readonly acpProjects?:
    | ReadonlyArray<{
        readonly id: ProjectId;
        readonly title: string;
        readonly workspaceRoot: string;
      }>
    | undefined;
}

const EMPTY_ACP_PROJECTS: NonNullable<ProviderInstanceCardProps["acpProjects"]> = [];
const NO_SECRET_SOURCES: ReadonlyArray<SecretSource> = [];
const NO_CUSTOM_MODELS: ReadonlyArray<CustomModelDefinition> = [];

/**
 * Every custom model save writes the whole list, so the next edit starts from the last list sent
 * until the config stream echoes it, which can land before or after the save's reply.
 */
function useCustomModelSaves(
  stored: ReadonlyArray<CustomModelDefinition>,
  save: (next: ReadonlyArray<CustomModelDefinition>) => Promise<boolean>,
) {
  const [saves, setSaves] = useState<ReadonlyArray<CustomModelSave>>([]);
  const storedKey = customModelsKey(stored);
  const [previousStoredKey, setPreviousStoredKey] = useState(storedKey);
  if (previousStoredKey !== storedKey) {
    setPreviousStoredKey(storedKey);
    // Unchanged contents can match a queued restore, so only a stream change can be an echo.
    setSaves((list) => pendingCustomModelSaves(list, storedKey));
  }
  const current = saves.at(-1)?.models ?? stored;
  const update = useStableCallback(async (next: ReadonlyArray<CustomModelDefinition>) => {
    const sent: CustomModelSave = { models: next, key: customModelsKey(next) };
    setSaves((list) => [...list, sent]);
    const saved = await save(next);
    setSaves((list) => settleCustomModelSave(list, sent, saved));
    return saved;
  });
  return [current, update] as const;
}

/** Unknown drivers stay read-only to preserve fork config. projectOverride switches affect only the
 * project, not instance.enabled. */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  mode,
  selected = false,
  onConfigure,
  readOnly = false,
  canWriteSettings = true,
  onUpdate,
  onDelete,
  headerAction,
  setup,
  runtime,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onToggleFavorite,
  onModelOrderChange,
  onRunUpdate,
  onInstallRecommended,
  isUpdating = false,
  onAcceptUrlAuth,
  environmentId,
  acpProjects = EMPTY_ACP_PROJECTS,
  secretSources = NO_SECRET_SOURCES,
  projectOverride,
}: ProviderInstanceCardProps) {
  const gt = useGT();
  const m = useMessages();
  const enabled = projectOverride?.effectiveEnabled ?? resolveProviderInstanceEnabled(instance);
  const effectiveProvider = liveProvider && { ...liveProvider, enabled };
  const compatibility = enabled ? liveProvider?.compatibilityAdvisory : undefined;
  const statusKey = enabled ? getProviderStatusKey(effectiveProvider) : "disabled";
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const summary = enabled
    ? getProviderSummary(effectiveProvider, m)
    : { headline: gt("Disabled", { $context: "provider status" }), detail: null, authLabel: null };
  const authEmail = liveProvider?.auth.email?.trim();
  const isAuthenticated = enabled && liveProvider?.auth.status === "authenticated";
  const authLabel =
    enabled && liveProvider?.auth.status === "authenticated"
      ? (providerAuthLabel(liveProvider.auth, m) ?? null)
      : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const updateAdvisory = getProviderVersionAdvisoryPresentation(
    liveProvider?.versionAdvisory,
    liveProvider?.compatibilityAdvisory,
    enabled,
    m,
  );
  const reinstallCommand =
    enabled && !updateAdvisory ? getProviderReinstallCommand(liveProvider) : null;
  const isReinstall = reinstallCommand !== null;
  const versionAdvisory =
    updateAdvisory ??
    (isReinstall
      ? {
          title: gt("Reinstall needed"),
          detail: gt(
            "This installation is missing files it needs to start. Reinstall it to fix it.",
          ),
          updateCommand: reinstallCommand,
          emphasis: "strong" as const,
          targetVersion: null,
        }
      : null);
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const updateState = liveProvider?.updateState;
  const updateProgress = isUpdating
    ? ((updateState?.status === "queued" || updateState?.status === "running"
        ? updateState.message
        : null) ?? gt("Starting update"))
    : null;
  const updateProblem =
    !isUpdating && (updateState?.status === "failed" || updateState?.status === "unchanged")
      ? updateState.message
      : null;
  const restartNotice =
    enabled && !isUpdating && liveProvider ? getProviderRestartNotice(liveProvider) : null;
  const hasCompatibilityWarning =
    compatibility !== undefined &&
    compatibility.status !== "supported" &&
    compatibility.status !== "unknown";
  const VersionAdvisoryIcon =
    hasCompatibilityWarning || isReinstall ? AlertTriangleIcon : ArrowUpCircleIcon;
  // Version warnings never get a banner: the glyph carries the sentence and its popover the fix.
  const versionAdvisoryLabel = versionAdvisory
    ? `${versionAdvisory.title}. ${versionAdvisory.detail}`
    : null;
  const onRunVersionAction = readOnly
    ? undefined
    : versionAdvisory?.targetVersion
      ? onInstallRecommended
      : onRunUpdate;
  const urlAuthAction = liveProvider?.auth.action;
  const displayName =
    instance.displayName?.trim() || driverOption?.label || String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  const managedPolicy = useManagedPolicy(environmentId);
  const instanceLocks = managedInstanceLocks(managedPolicy, instance.driver, m);
  const managedDriverReason = isManagedDriverAllowed(managedPolicy, instance.driver)
    ? undefined
    : disallowedProviderMessage(
        managedPolicy?.organization,
        driverOption?.label ?? String(instance.driver),
      );
  const { copyToClipboard } = useCopyToClipboard<{ providerName: string }>({
    onCopy: ({ providerName }) => {
      toastManager.add({
        type: "success",
        title: gt("{provider} update command copied", { provider: providerName }),
        description: gt("Run it in a terminal when you are ready to update."),
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy {provider} update command", { provider: providerName }),
          description: error.message,
        }),
      );
    },
  });

  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;
  const storedCustomModels =
    instance.config !== null && typeof instance.config === "object"
      ? (instance.config as Record<string, unknown>).customModels
      : undefined;
  const [customModels, updateCustomModels] = useCustomModelSaves(
    instance.driver === "antigravity"
      ? NO_CUSTOM_MODELS
      : readCustomModelEntries(storedCustomModels),
    (next) => {
      const nextConfig = nextConfigBlobWithValue(
        instance.config,
        "customModels",
        next.map(toCustomModelSetting),
      );
      const { config: _omit, ...rest } = instance;
      return onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
    },
  );
  const modelsForDisplay = deriveProviderModelsForDisplay({
    liveModels: liveProvider?.models,
    customModels,
  });
  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = instance;
    onUpdate(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnabled = (value: boolean) => {
    if (projectOverride) {
      projectOverride.onChange(value);
      return;
    }
    onUpdate({ ...instance, enabled: value });
  };

  const readsUsage = Object.values(PROVIDER_PRESENTATION).some(
    (presentation) => presentation.driverKind === instance.driver,
  );
  const updateUsageAccess = (allowed: boolean) =>
    onUpdate({ ...instance, usageAccess: allowed ? "allowed" : "denied" });

  const updateAccentColor = (value: string) => {
    const normalized = normalizeProviderAccentColor(value);
    const { accentColor: _omit, ...rest } = instance;
    onUpdate(
      normalized
        ? ({ ...rest, accentColor: normalized } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateConfig = (nextConfig: Record<string, unknown> | undefined) => {
    const { config: _omit, ...rest } = instance;
    onUpdate(
      nextConfig !== undefined
        ? ({ ...rest, config: nextConfig } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnvironment = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    const cleaned = environment.filter((variable) => variable.name.trim().length > 0);
    const { environment: _omit, ...rest } = instance;
    onUpdate(
      cleaned.length > 0
        ? ({ ...rest, environment: cleaned } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };
  const environmentFields = driverOption?.environmentFields ?? [];
  const environmentFieldNames = new Set(environmentFields.map((field) => field.name));
  const genericEnvironment = providerEnvironmentWithoutNames(
    instance.environment,
    environmentFieldNames,
  );
  const updateGenericEnvironment = (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => {
    const dedicatedEnvironment = (instance.environment ?? []).filter((variable) =>
      environmentFieldNames.has(variable.name),
    );
    updateEnvironment([...dedicatedEnvironment, ...environment]);
  };
  const updateEnvironmentField = (field: ProviderEnvironmentField, value: string) => {
    updateEnvironment(nextProviderEnvironmentWithFieldValue(instance.environment, field, value));
  };
  const updateEnvironmentFieldSecret = (
    field: ProviderEnvironmentField,
    secret: SecretReference | undefined,
  ) => {
    updateEnvironment(nextProviderEnvironmentWithFieldSecret(instance.environment, field, secret));
  };
  const removeEnvironmentField = (field: ProviderEnvironmentField) => {
    updateEnvironment(providerEnvironmentWithoutNames(instance.environment, new Set([field.name])));
  };

  const titleIconNode = (
    <ProviderInstanceIcon
      driverKind={driverKind ?? instance.driver}
      displayName={displayName}
      accentColor={accentColor}
      acpRegistryAgentId={
        readConfigString(instance.config, "source") === "local"
          ? undefined
          : (readConfigString(instance.config, "agentId") ?? undefined)
      }
      acpRegistryIconUrl={
        readConfigString(instance.config, "source") === "local"
          ? undefined
          : (readConfigString(instance.config, "registryIconUrl") ?? undefined)
      }
      showBadge={Boolean(accentColor)}
      className="size-4"
      iconClassName="size-4 text-muted-foreground"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
    />
  );

  const titleTailNode = headerAction ? (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{headerAction}</span>
  ) : null;

  const versionCodeNode = versionLabel ? (
    <code className="font-mono text-meta text-dim-foreground">{versionLabel}</code>
  ) : null;

  const statusDotNode =
    statusKey === "warning" || statusKey === "error" ? <StatusDot tone={statusStyle.dot} /> : null;
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const statusDiagnostic = (
    <>
      {authLabel || summary.authLabel ? (
        <span className="block">{authLabel ?? summary.authLabel}</span>
      ) : null}
      {hasCompatibilityWarning && needsAttention && summary.detail ? (
        <span className="block">{summary.detail}</span>
      ) : null}
    </>
  );
  const hasStatusDiagnostic = Boolean(
    authLabel || summary.authLabel || (hasCompatibilityWarning && needsAttention && summary.detail),
  );
  const inlineStatusDetail = hasCompatibilityWarning
    ? compatibility?.status === "broken"
      ? gt("Incompatible")
      : compatibility?.status === "unsupported"
        ? gt("Unsupported")
        : gt("Limited support")
    : summary.detail;
  const editorStatusNode =
    isAuthenticated && authEmail ? (
      <>
        {needsAttention ? statusDotNode : null}
        <span className="min-w-0 max-w-full">
          <T>
            Authenticated as{" "}
            <Var>
              <ProviderAuthEmail email={authEmail} />
            </Var>
          </T>
        </span>
        {inlineStatusDetail ? (
          <span className="min-w-0 basis-full [overflow-wrap:anywhere]">{inlineStatusDetail}</span>
        ) : null}
      </>
    ) : (
      <>
        {statusDotNode}
        <span>{summary.headline}</span>
        {inlineStatusDetail ? (
          <span className="min-w-0 basis-full [overflow-wrap:anywhere]">{inlineStatusDetail}</span>
        ) : null}
      </>
    );
  const versionAdvisoryNode = versionAdvisory ? (
    <Popover>
      <SharedTooltipTrigger
        render={
          <PopoverTrigger
            render={
              <Button
                type="button"
                size={mode === "list" ? "icon-micro" : "icon-xs"}
                variant="ghost-muted"
                className={mode === "list" ? "pointer-events-auto relative shrink-0" : undefined}
                aria-label={gt("{status}, view details", {
                  status: updateProgress ? gt("Updating") : versionAdvisory.title,
                })}
              >
                {updateProgress ? (
                  <Spinner tone="muted" {...(mode === "list" ? { size: "sm" as const } : {})} />
                ) : (
                  <VersionAdvisoryIcon
                    className={cn(
                      mode === "list" && "size-3.5",
                      (hasCompatibilityWarning || isReinstall) && "text-warning-foreground",
                    )}
                  />
                )}
              </Button>
            }
          />
        }
        label={updateProgress ? gt("Updating") : versionAdvisoryLabel}
      />
      <PopoverPopup side="bottom" align="end" width="md" aria-label={versionAdvisory.title}>
        <div className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold leading-tight text-strong-foreground">
              {versionAdvisory.title}
            </p>
            <p
              className={cn(
                "text-xs leading-snug [overflow-wrap:anywhere]",
                versionAdvisory.emphasis === "strong"
                  ? "text-warning-foreground"
                  : "text-muted-foreground",
              )}
            >
              {versionAdvisory.detail}
            </p>
          </div>
          {onRunVersionAction ? (
            <ProviderVersionUpdateAction
              advisory={versionAdvisory}
              isReinstall={isReinstall}
              isUpdating={isUpdating}
              progress={updateProgress}
              problem={updateProblem}
              stretch
              onRun={onRunVersionAction}
            />
          ) : null}
          {onRunVersionAction && updateCommand ? (
            <div className="flex items-center gap-2 text-3xs font-medium text-muted-foreground">
              <span aria-hidden className="h-px flex-1 bg-border" />
              <T>or, update manually using</T>
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>
          ) : null}
          {updateCommand ? (
            <div className="flex min-w-0 items-center gap-1 rounded-control surface-well py-0.5 pr-0.5 pl-2">
              <code className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">
                {updateCommand}
              </code>
              <SharedTooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    className="shrink-0"
                    onClick={() => copyToClipboard(updateCommand, { providerName: displayName })}
                    aria-label={gt("Copy update command")}
                  >
                    <CopyIcon className="size-3" />
                  </Button>
                }
                label={
                  <>
                    <T>Copy command</T>
                  </>
                }
              />
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  ) : null;

  if (mode === "list") {
    const statusLine = updateProgress ? (
      <span aria-live="polite" className="line-clamp-2 [overflow-wrap:anywhere]">
        <span>{gt("Updating")}</span>
        <span className="block">{updateProgress}</span>
      </span>
    ) : isAuthenticated && authEmail ? (
      <span className="min-w-0 max-w-full">
        <T>
          Authenticated as{" "}
          <Var>
            <ProviderAuthEmail email={authEmail} />
          </Var>
        </T>
      </span>
    ) : (
      <span className="line-clamp-2 [overflow-wrap:anywhere]">
        {enabled ? summary.headline : gt("Disabled", { $context: "provider status" })}
        {enabled && needsAttention && inlineStatusDetail ? (
          <span className="block">{inlineStatusDetail}</span>
        ) : null}
      </span>
    );
    return (
      <div
        data-slot="provider-card"
        data-selected={selected ? "" : undefined}
        onClickCapture={(event) => {
          if (
            event.target instanceof Element &&
            !event.target.closest('button, input, [role="switch"], [data-slot="popover-trigger"]')
          ) {
            onConfigure?.();
          }
        }}
        className={cn(
          "relative flex items-start gap-2.5 rounded-row p-2.5",
          selected ? "surface-selected-soft" : "hover:surface-ghost-hover",
        )}
      >
        {/* The overlay avoids nesting the email and enable controls inside a button. */}
        <button
          type="button"
          className="absolute inset-0 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onConfigure}
          aria-current={selected || undefined}
          aria-label={gt("Configure {provider}", { provider: displayName })}
        />
        <span
          className={cn(
            "pointer-events-none relative mt-px flex h-4.5 shrink-0 items-center",
            !enabled && "opacity-64",
          )}
        >
          {titleIconNode}
        </span>
        <div
          className={cn("pointer-events-none relative min-w-0 flex-1", !enabled && "opacity-64")}
        >
          {/* Wraps instead of shrinking, so the name keeps its width and the
              version and chips move to the next line in a narrow column. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <Text variant="label" truncate>
              {displayName}
            </Text>
            {enabled && !updateProgress ? statusDotNode : null}
            {versionLabel ? (
              <code className="shrink-0 font-mono text-meta text-dim-foreground">
                {versionLabel}
              </code>
            ) : null}
            {enabled ? versionAdvisoryNode : null}
            {driverOption?.badgeLabel ? (
              <Badge variant="warning" size="sm">
                {driverOption.badgeLabel}
              </Badge>
            ) : null}
          </span>
          <ProviderStatusDiagnostic detail={hasStatusDiagnostic ? statusDiagnostic : null}>
            <span
              className={cn(
                "mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1 text-meta leading-normal text-muted-foreground",
                hasStatusDiagnostic &&
                  "pointer-events-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              )}
              tabIndex={hasStatusDiagnostic ? 0 : undefined}
            >
              {statusLine}
            </span>
          </ProviderStatusDiagnostic>
        </div>
        <span className="relative flex shrink-0 items-center">
          <ManagedControl reason={enabled ? undefined : managedDriverReason}>
            <Switch
              checked={enabled}
              disabled={readOnly || (projectOverride !== undefined && !canWriteSettings)}
              onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
              aria-label={gt("Enable {provider}", { provider: displayName })}
            />
          </ManagedControl>
        </span>
      </div>
    );
  }

  const editorHeaderAction = (
    <div className="flex shrink-0 items-center gap-1.5">
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
      {versionCodeNode}
      {versionAdvisoryNode}
      <span
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        // Empty, it would still add a flex gap and pull the version off the column edge.
        className={cn("inline-flex items-center gap-1 empty:hidden", readOnly && "opacity-50")}
      >
        {titleTailNode}
        {projectOverride?.value !== undefined ? (
          <span className="flex items-center">
            <ProjectOverrideInheritance
              projectEnabled={projectOverride.value}
              deviceEnabled={resolveProviderInstanceEnabled(instance)}
            />
            <SettingResetButton
              ariaLabel={gt("Reset {provider} enablement to default", { provider: displayName })}
              tooltip={gt("Reset to the device setting")}
              disabled={readOnly || !canWriteSettings}
              onClick={projectOverride.onReset}
            />
          </span>
        ) : null}
        {onDelete ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-destructive"
            disabled={readOnly}
            onClick={onDelete}
            aria-label={gt("Delete instance {instanceId}", { instanceId })}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </span>
    </div>
  );

  const statusContent = (
    <>
      <ProviderStatusDiagnostic detail={hasStatusDiagnostic ? statusDiagnostic : null}>
        <div
          tabIndex={hasStatusDiagnostic ? 0 : undefined}
          className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
        >
          {editorStatusNode}
        </div>
      </ProviderStatusDiagnostic>
      {restartNotice ? (
        <p aria-live="polite" className="text-xs leading-snug [overflow-wrap:anywhere]">
          {restartNotice}
        </p>
      ) : null}
      {versionAdvisory && onRunVersionAction ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <ProviderVersionUpdateAction
            advisory={versionAdvisory}
            isReinstall={isReinstall}
            isUpdating={isUpdating}
            progress={updateProgress}
            problem={updateProblem}
            stretch={false}
            onRun={onRunVersionAction}
          />
        </div>
      ) : null}
      {urlAuthAction && onAcceptUrlAuth ? (
        <div className="grid max-w-xl gap-1.5 pt-1 text-meta">
          <p>{urlAuthAction.message}</p>
          <code className="break-all text-caption">{urlAuthAction.url}</code>
          <Button
            render={
              <a
                href={urlAuthAction.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onAcceptUrlAuth(urlAuthAction)}
              />
            }
            size="xs"
            variant="secondary"
            className="w-fit"
            disabled={readOnly}
          >
            <ExternalLinkIcon />
            <T>Continue authentication</T>
          </Button>
        </div>
      ) : null}
    </>
  );

  const runtimeFields = driverOption ? (
    <ProviderSettingsForm
      definition={driverOption}
      value={instance.config}
      idPrefix={`provider-instance-${instanceId}`}
      variant="settings"
      onChange={updateConfig}
      managed={instanceLocks && { keys: instanceLocks.configKeys, reason: instanceLocks.reason }}
      environmentId={environmentId}
    />
  ) : (
    <SettingsRow
      title={gt("Driver")}
      description={
        <span>
          <T>
            This instance uses{" "}
            <code className="text-foreground">
              <Var>{String(instance.driver)}</Var>
            </code>
            , which is not available in this build. Its configuration is preserved.
          </T>
        </span>
      }
    />
  );

  return (
    <>
      <div className="space-y-4">
        <div className="flex min-h-7 items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2">
            {titleIconNode}
            <Text variant="label" truncate>
              {displayName}
            </Text>
          </h2>
          {editorHeaderAction}
        </div>
        <SettingsGroup>
          <SettingsRow
            title={gt("Display name")}
            status={statusContent}
            control={
              <div
                inert={readOnly}
                aria-disabled={readOnly || undefined}
                className={cn(
                  "flex w-full min-w-0 items-center justify-end gap-2 @min-[26rem]/settings-row:w-auto",
                  readOnly && "opacity-50 select-none",
                )}
              >
                <ProviderAccentColorPicker
                  layout="inline"
                  displayName={displayName}
                  value={accentColor}
                  onCommit={updateAccentColor}
                />
                <DraftInput
                  id={`provider-instance-${instanceId}-display-name`}
                  size="settings"
                  className="min-w-0 flex-1 @min-[26rem]/settings-row:w-50"
                  value={instance.displayName ?? ""}
                  onCommit={updateDisplayName}
                  placeholder={driverOption?.label ?? gt("Instance label")}
                  spellCheck={false}
                />
              </div>
            }
          />
          {readsUsage ? (
            <SettingsRow
              title={gt("Usage access")}
              description={<UsageAccessReads driver={instance.driver} />}
              control={
                <Switch
                  checked={instance.usageAccess === "allowed"}
                  disabled={readOnly}
                  onCheckedChange={(checked) => updateUsageAccess(Boolean(checked))}
                  aria-label={gt("Usage access for {provider}", { provider: displayName })}
                />
              }
            />
          ) : null}
        </SettingsGroup>
      </div>

      {setup || environmentFields.length > 0 ? (
        <SettingsSection title={gt("Setup")}>
          {setup}
          {environmentFields.length > 0 ? (
            <div
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={readOnly ? "opacity-50 select-none" : undefined}
            >
              {environmentFields.map((field) => (
                <ProviderEnvironmentFieldRow
                  key={field.name}
                  field={field}
                  variable={readProviderEnvironmentVariable(instance.environment, field.name)}
                  idPrefix={`provider-instance-${instanceId}`}
                  onCommit={updateEnvironmentField}
                  onSecretChange={updateEnvironmentFieldSecret}
                  onRemove={removeEnvironmentField}
                  managedReason={
                    instanceLocks?.wholeEnvironment ||
                    instanceLocks?.environmentNames.has(field.name)
                      ? instanceLocks.reason
                      : undefined
                  }
                  secretSources={secretSources}
                  environmentId={environmentId}
                />
              ))}
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {instance.driver === "codex" && readCodexSetupMode(instance.config) === "managed" ? (
        <div
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          <FoldedSettingsSection
            key={instanceId}
            id={`provider-instance-${instanceId}-runtime`}
            title={gt("Runtime")}
            headerPlacement="outside"
          >
            {runtime ?? runtimeFields}
          </FoldedSettingsSection>
        </div>
      ) : !driverOption || deriveProviderSettingsFields(driverOption, undefined, m).length > 0 ? (
        <SettingsSection
          title={gt("Runtime")}
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          {runtimeFields}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={gt("Environment")}
        inert={readOnly || instanceLocks?.wholeEnvironment}
        aria-disabled={readOnly || instanceLocks?.wholeEnvironment || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        {instanceLocks?.wholeEnvironment ? (
          <ManagedNotice>{instanceLocks.reason}</ManagedNotice>
        ) : null}
        <div className={instanceLocks?.wholeEnvironment ? "opacity-50" : undefined}>
          <ProviderEnvironmentSection
            environment={genericEnvironment}
            onChange={updateGenericEnvironment}
            secretSources={secretSources}
            environmentId={environmentId}
            managed={
              instanceLocks && {
                names: instanceLocks.environmentNames,
                reason: instanceLocks.reason,
              }
            }
          />
        </div>
      </SettingsSection>
      {environmentId !== undefined && liveProvider?.driver === "acpRegistry" ? (
        <AcpSessionManagementSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={liveProvider}
          projects={acpProjects}
          readOnly={readOnly}
        />
      ) : null}

      {driverOption !== undefined ? (
        <SettingsSection title={gt("Models")}>
          <div className="px-3 py-3 sm:px-4">
            <p className="mb-3 text-meta text-muted-foreground">
              <T>
                Model preferences and custom models are saved on the selected environment and shared
                across connected devices.
              </T>
            </p>
            <ProviderModelsSection
              canManageCustomModels={!readOnly}
              canWritePreferences={canWriteSettings}
              instanceId={instanceId}
              driverKind={driverKind}
              models={modelsForDisplay}
              customModels={customModels}
              hiddenModels={hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelOrder}
              onChange={updateCustomModels}
              onHiddenModelsChange={onHiddenModelsChange}
              onFavoriteModelsChange={onFavoriteModelsChange}
              onToggleFavorite={onToggleFavorite}
              onModelOrderChange={onModelOrderChange}
            />
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}
