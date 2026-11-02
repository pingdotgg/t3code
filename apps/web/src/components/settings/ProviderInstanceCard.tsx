import { useT } from "../../hooks/useI18n";
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
} from "lucide-react";
import { Lock as LockGlyph, LockOpen } from "lucide";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { Fragment, useState, type ReactElement, type ReactNode } from "react";
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
import { MorphIcon } from "~/components/MorphIcon";
import { DraftInput } from "../ui/draft-input";
import { SecretSourceInput, type SecretSource } from "./SecretSourceInput";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { ManagedControl, ManagedNotice } from "../ManagedPolicy";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { disallowedProviderMessage, isManagedDriverAllowed } from "@t3tools/contracts";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { AcpSessionManagementSection } from "./AcpSessionManagementSection";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import {
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderStatusKey,
  getProviderSummary,
  getProviderVersionLabel,
} from "./providerStatus";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ProviderStatusDiagnostic({
  detail,
  children,
}: {
  detail: string | null;
  children: ReactElement;
}) {
  if (!detail) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="top">{detail}</TooltipPopup>
    </Tooltip>
  );
}

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

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
  const t = useT();
  const email = props.email?.trim();
  if (!email) return null;

  return (
    <RedactedSensitiveText
      value={email}
      ariaLabel={t("settings.providers.auth.toggleEmail")}
      revealTooltip={t("settings.providers.auth.revealEmail")}
      hideTooltip={t("settings.providers.auth.hideEmail")}
      className="max-w-full truncate"
    />
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
}) {
  const t = useT();
  const inputId = `${props.idPrefix}-environment-${props.field.name}`;
  const value = props.variable?.valueRedacted ? "" : (props.variable?.value ?? "");

  return (
    <SettingsRow
      title={<label htmlFor={inputId}>{props.field.label}</label>}
      description={props.field.description}
      managed={props.managedReason}
      control={
        <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-56">
          {props.field.sensitive === false ? (
            <DraftInput
              id={inputId}
              size="sm"
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
              size="sm"
              className="min-w-0 flex-1"
              value={value}
              onCommit={(next) => props.onCommit(props.field, next)}
              placeholder={props.field.placeholder}
              configured={props.variable?.valueRedacted === true}
              spellCheck={false}
              aria-label={props.field.label}
              sources={props.secretSources}
              onSecretChange={(secret) => props.onSecretChange(props.field, secret)}
            />
          )}
          {props.variable ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-destructive"
              onClick={() => props.onRemove(props.field)}
              aria-label={t("settings.providers.form.clear", { label: String(props.field.label) })}
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
}) {
  const t = useT();
  const [storedDraft, setDraft] = useState(() =>
    seedRowsDraft(props.environment, toEnvironmentDraftRows),
  );
  const draft = reconcileRowsDraft(
    storedDraft,
    props.environment,
    providerEnvironmentsEqual,
    toEnvironmentDraftRows,
  );
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
      title={t("settings.providers.card.variables")}
      description={t("settings.providers.card.variablesDescription")}
      control={
        <Button type="button" size="sm" variant="outline" onClick={addVariable}>
          <PlusIcon className="size-3" />
          {t("settings.providers.card.addVariable")}
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((variable, index) => {
            if (props.managed?.names.has(variable.name)) {
              return (
                <div key={variable.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <code className="min-w-0 truncate text-xs sm:w-44 sm:shrink-0">
                    {variable.name}
                  </code>
                  <span className="text-xs text-muted-foreground">{props.managed.reason}</span>
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
                placeholder={t("settings.providers.card.variableNamePlaceholder")}
                spellCheck={false}
                aria-label={t("settings.providers.card.variableName", {
                  number: String(index + 1),
                })}
              />
            );
            const removeButton = (
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() => removeVariable(variable.id)}
                aria-label={t("settings.providers.card.removeVariable", {
                  name: String(variable.name || index + 1),
                })}
              >
                <XIcon className="size-3" />
              </Button>
            );
            const sensitiveToggle =
              typeof variable.value === "string" ? (
                <Tooltip>
                  <TooltipTrigger
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
                        aria-label={t("settings.providers.card.markSensitive", {
                          name: String(variable.name || index + 1),
                        })}
                      >
                        <MorphIcon
                          className="size-3"
                          icon={variable.sensitive ? LockGlyph : LockOpen}
                        />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">
                    {variable.sensitive
                      ? t("settings.providers.card.sensitive")
                      : t("settings.providers.card.plain")}
                  </TooltipPopup>
                </Tooltip>
              ) : null;
            const layout = (source: ReactNode, value: ReactNode) => (
              <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-2">
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
                    placeholder={t("settings.providers.customModel.choiceValuePlaceholder")}
                    configured={variable.valueRedacted === true}
                    spellCheck={false}
                    aria-label={t("settings.providers.card.variableValue", {
                      number: String(index + 1),
                    })}
                    sources={props.secretSources ?? []}
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
                      placeholder={t("settings.providers.customModel.choiceValuePlaceholder")}
                      spellCheck={false}
                      aria-label={t("settings.providers.card.variableValue", {
                        number: String(index + 1),
                      })}
                    />,
                  )
                )}
              </Fragment>
            );
          })}
          <p className="text-xs text-muted-foreground">
            {t("settings.providers.card.sensitiveStored")}
            {rows.some((row) => row.valueRedacted === true)
              ? ` ${t("settings.providers.card.sensitiveStoredRenameHint")}`
              : null}
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
  const t = useT();
  const layers = [
    {
      key: "project",
      label: t("settings.providers.card.project"),
      enabled: projectEnabled,
      effective: true,
    },
    {
      key: "device",
      label: t("settings.providers.card.device"),
      enabled: deviceEnabled,
      effective: false,
    },
  ];
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
                  aria-label={t("settings.providers.card.overrideA11y")}
                />
              }
            />
          }
        >
          <LayersIcon className="size-3 text-primary" />
        </TooltipTrigger>
        <TooltipPopup side="top">{t("settings.providers.card.overridden")}</TooltipPopup>
      </Tooltip>
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
                {layer.enabled ? t("settings.providers.card.on") : t("settings.providers.card.off")}
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
  readonly mode: "list" | "editor";
  readonly selected?: boolean | undefined;
  readonly onSelect?: (() => void) | undefined;
  readonly readOnly?: boolean | undefined;
  readonly canWriteSettings?: boolean;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
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

/** Unknown drivers stay read-only to preserve fork config. projectOverride switches affect only the
 * project, not instance.enabled. */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  mode,
  selected = false,
  onSelect,
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
  const t = useT();
  const enabled = projectOverride?.effectiveEnabled ?? resolveProviderInstanceEnabled(instance);
  const effectiveProvider = liveProvider && { ...liveProvider, enabled };
  const compatibility = enabled ? liveProvider?.compatibilityAdvisory : undefined;
  const statusKey = enabled ? getProviderStatusKey(effectiveProvider) : "disabled";
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const summary = enabled
    ? getProviderSummary(effectiveProvider, t)
    : { headline: t("settings.providers.card.disabled"), detail: null };
  const authEmail = liveProvider?.auth.email?.trim();
  const isAuthenticated = enabled && liveProvider?.auth.status === "authenticated";
  const authLabel =
    enabled && liveProvider?.auth.status === "authenticated"
      ? (liveProvider.auth.label ?? liveProvider.auth.type ?? null)
      : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(
    liveProvider?.versionAdvisory,
    liveProvider?.compatibilityAdvisory,
    enabled,
    t,
  );
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const updateState = liveProvider?.updateState;
  const updateProgress = isUpdating
    ? ((updateState?.status === "queued" || updateState?.status === "running"
        ? updateState.message
        : null) ?? t("settings.providers.card.startingUpdate"))
    : null;
  const updateProblem =
    !isUpdating && (updateState?.status === "failed" || updateState?.status === "unchanged")
      ? updateState.message
      : null;
  const hasCompatibilityWarning =
    compatibility !== undefined &&
    compatibility.status !== "supported" &&
    compatibility.status !== "unknown";
  const VersionAdvisoryIcon = hasCompatibilityWarning ? AlertTriangleIcon : ArrowUpCircleIcon;
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
  const instanceLocks = managedInstanceLocks(managedPolicy, instance.driver);
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
        title: t("settings.providers.card.updateCopied", { provider: String(providerName) }),
        description: t("settings.providers.card.updateCopiedDescription"),
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.providers.card.updateCopyFailed", { provider: String(providerName) }),
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
  const customModels =
    instance.driver === "antigravity"
      ? NO_CUSTOM_MODELS
      : readCustomModelEntries(storedCustomModels);
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

  const updateCustomModels = useStableCallback((next: ReadonlyArray<CustomModelDefinition>) => {
    const nextConfig = nextConfigBlobWithValue(
      instance.config,
      "customModels",
      next.map(toCustomModelSetting),
    );
    const { config: _omit, ...rest } = instance;
    onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
  });

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
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
    />
  );

  const titleTailNode = headerAction ? (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{headerAction}</span>
  ) : null;

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;

  const statusDotNode =
    statusKey === "warning" || statusKey === "error" ? (
      <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} aria-hidden />
    ) : null;
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const statusDiagnostic = hasCompatibilityWarning && needsAttention ? summary.detail : null;
  const inlineStatusDetail = hasCompatibilityWarning
    ? compatibility?.status === "broken"
      ? t("settings.providers.card.incompatible")
      : compatibility?.status === "unsupported"
        ? t("settings.providers.card.unsupported")
        : t("settings.providers.card.limited")
    : summary.detail;
  const editorStatusNode =
    isAuthenticated && authEmail ? (
      <>
        {needsAttention ? statusDotNode : null}
        <span>{t("settings.providers.card.authenticatedAs")}</span>
        <ProviderAuthEmail email={authEmail} />
        {authLabel ? <span>· {authLabel}</span> : null}
        {inlineStatusDetail ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">· {inlineStatusDetail}</span>
        ) : null}
      </>
    ) : (
      <>
        {statusDotNode}
        <span>{summary.headline}</span>
        {inlineStatusDetail ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">· {inlineStatusDetail}</span>
        ) : null}
      </>
    );
  const versionAdvisoryNode = versionAdvisory ? (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size={mode === "list" ? "icon-micro" : "icon-xs"}
                  variant="ghost-muted"
                  className={mode === "list" ? "pointer-events-auto relative shrink-0" : undefined}
                  aria-label={t("settings.providers.card.updatingDetails", {
                    label: String(
                      updateProgress
                        ? t("settings.providers.card.updating")
                        : versionAdvisory.title,
                    ),
                  })}
                >
                  {updateProgress ? (
                    <Spinner tone="muted" {...(mode === "list" ? { size: "sm" as const } : {})} />
                  ) : (
                    <VersionAdvisoryIcon
                      className={cn(
                        mode === "list" && "size-3.5",
                        hasCompatibilityWarning && "text-warning",
                      )}
                    />
                  )}
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">
          {updateProgress ? t("settings.providers.card.updating") : versionAdvisory.title}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" width="md" aria-label={versionAdvisory.title}>
        <div className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold leading-tight text-foreground">
              {versionAdvisory.title}
            </p>
            <p
              className={cn(
                "text-xs leading-snug [overflow-wrap:anywhere]",
                versionAdvisory.emphasis === "strong" ? "text-warning" : "text-muted-foreground",
              )}
            >
              {versionAdvisory.detail}
            </p>
          </div>
          {onRunVersionAction ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="w-full"
              disabled={isUpdating}
              onClick={onRunVersionAction}
            >
              {isUpdating ? <Spinner /> : <DownloadIcon />}
              {isUpdating
                ? t("settings.providers.card.updating")
                : versionAdvisory.targetVersion
                  ? t("settings.providers.card.installVersion", {
                      version: String(getProviderVersionLabel(versionAdvisory.targetVersion)),
                    })
                  : t("settings.providers.card.updateNow")}
            </Button>
          ) : null}
          {updateProgress || updateProblem ? (
            <p
              aria-live="polite"
              className={cn(
                "text-xs leading-snug [overflow-wrap:anywhere]",
                updateProblem ? "text-warning" : "text-muted-foreground",
              )}
            >
              {updateProgress ?? updateProblem}
            </p>
          ) : null}
          {onRunVersionAction && updateCommand ? (
            <div className="flex items-center gap-2 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
              <span aria-hidden className="h-px flex-1 bg-border" />
              {t("settings.providers.card.orManual")}
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>
          ) : null}
          {updateCommand ? (
            <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
              <code className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">
                {updateCommand}
              </code>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      className="shrink-0"
                      onClick={() => copyToClipboard(updateCommand, { providerName: displayName })}
                      aria-label={t("settings.providers.card.copyUpdate")}
                    >
                      <CopyIcon className="size-3" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">{t("settings.providers.card.copyCommand")}</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  ) : null;

  if (mode === "list") {
    return (
      <div
        data-slot="settings-row"
        className={cn(
          "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4",
          selected ? "bg-foreground/[0.06]" : "hover:bg-muted/25",
        )}
      >
        <div
          className={cn(
            "pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-opacity",
            !enabled && !selected && "opacity-60 group-hover:opacity-100",
          )}
        >
          <button
            type="button"
            className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={onSelect}
            aria-label={t("settings.providers.card.select", { name: String(displayName) })}
            aria-pressed={selected}
          />
          {titleIconNode}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              {versionLabel ? (
                <code className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {versionLabel}
                </code>
              ) : null}
              {versionAdvisoryNode}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-xs leading-normal text-muted-foreground/80">
              {statusDotNode && !updateProgress ? (
                <span className="flex h-[1.45em] shrink-0 items-center">{statusDotNode}</span>
              ) : null}
              <ProviderStatusDiagnostic detail={statusDiagnostic}>
                <span
                  tabIndex={statusDiagnostic ? 0 : undefined}
                  aria-live="polite"
                  className="pointer-events-auto line-clamp-2 [overflow-wrap:anywhere]"
                >
                  {updateProgress ? (
                    t("settings.providers.card.updatingProgress", {
                      progress: String(updateProgress),
                    })
                  ) : (
                    <>
                      {summary.headline}
                      {needsAttention && inlineStatusDetail ? ` · ${inlineStatusDetail}` : null}
                    </>
                  )}
                </span>
              </ProviderStatusDiagnostic>
            </span>
          </span>
        </div>
        <span className="flex h-5 shrink-0 items-center gap-1">
          {projectOverride?.value !== undefined ? (
            <span className="flex items-center">
              <ProjectOverrideInheritance
                projectEnabled={projectOverride.value}
                deviceEnabled={resolveProviderInstanceEnabled(instance)}
              />
              <SettingResetButton
                label={t("settings.providers.card.enablement", { name: String(displayName) })}
                tooltip={t("settings.providers.card.resetDevice")}
                disabled={readOnly || !canWriteSettings}
                onClick={projectOverride.onReset}
              />
            </span>
          ) : null}
          {/* The policy refuses switching it on; switching it off stays the user's call. */}
          <ManagedControl reason={enabled ? undefined : managedDriverReason}>
            <Switch
              checked={enabled}
              disabled={readOnly || (projectOverride !== undefined && !canWriteSettings)}
              onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
              aria-label={t("settings.providers.card.enable", { name: String(displayName) })}
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
        {onDelete ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-destructive"
            disabled={readOnly}
            onClick={onDelete}
            aria-label={t("settings.providers.card.delete", { id: String(instanceId) })}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </span>
    </div>
  );

  // Provider status gets its own row instead of hanging under the name field.
  const statusContent = (
    <>
      <ProviderStatusDiagnostic detail={statusDiagnostic}>
        <div
          tabIndex={statusDiagnostic ? 0 : undefined}
          className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
        >
          {editorStatusNode}
        </div>
      </ProviderStatusDiagnostic>
      {urlAuthAction && onAcceptUrlAuth ? (
        <div className="grid max-w-xl gap-1.5 pt-1 text-xs">
          <p>{urlAuthAction.message}</p>
          <code className="break-all text-2xs">{urlAuthAction.url}</code>
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
            variant="outline"
            className="w-fit"
            disabled={readOnly}
          >
            <ExternalLinkIcon />
            {t("settings.providers.card.continueAuth")}
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
      title={t("settings.providers.card.driver")}
      description={t("settings.providers.card.unknownDriver", {
        driver: String(instance.driver),
      })}
    />
  );

  return (
    <>
      <SettingsSection title={displayName} icon={titleIconNode} headerAction={editorHeaderAction}>
        <SettingsRow title={t("settings.providers.card.status")} status={statusContent} />
        <SettingsRow
          title={t("settings.providers.card.displayName")}
          control={
            <div
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={cn(
                "flex w-full min-w-0 items-center justify-end gap-2 @min-[32rem]/settings-row:w-auto",
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
                size="sm"
                className="min-w-0 flex-1 @min-[32rem]/settings-row:w-56"
                value={instance.displayName ?? ""}
                onCommit={updateDisplayName}
                placeholder={driverOption?.label ?? t("settings.providers.card.instanceLabel")}
                spellCheck={false}
              />
            </div>
          }
        />
      </SettingsSection>

      {setup || environmentFields.length > 0 ? (
        <SettingsSection title={t("settings.providers.card.setupSection")}>
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
            title={t("settings.providers.card.runtime")}
            headerPlacement="outside"
          >
            {runtime ?? runtimeFields}
          </FoldedSettingsSection>
        </div>
      ) : !driverOption || deriveProviderSettingsFields(driverOption).length > 0 ? (
        <SettingsSection
          title={t("settings.providers.card.runtime")}
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          {runtimeFields}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t("settings.providers.card.environment")}
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
        <SettingsSection title={t("settings.providers.card.models")}>
          <div className="px-3 py-3 sm:px-4">
            <p className="mb-3 text-xs text-muted-foreground">
              {t("settings.providers.card.modelsDescription")}
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
