"use client";

import {
  ArrowUpCircleIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  LoaderIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { useState, type ReactNode } from "react";
import {
  isProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderDriverKind,
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
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption, ProviderEnvironmentFieldDefinition } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import {
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderSummary,
  getProviderVersionLabel,
  type ProviderStatusKey,
} from "./providerStatus";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
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

/**
 * Read `customModels` from the opaque config blob. The concrete driver
 * schemas type it as `CustomModelSetting[]`, but it arrives here as
 * `Schema.Unknown`, so the shared reader does the shape checking.
 */
function readConfigCustomModels(config: unknown): ReadonlyArray<CustomModelDefinition> {
  if (config === null || typeof config !== "object") return [];
  return readCustomModelEntries((config as Record<string, unknown>).customModels);
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
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

export function readProviderEnvironmentVariable(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  name: string,
): ProviderInstanceEnvironmentVariable | undefined {
  return environment?.find((variable) => variable.name === name);
}

export function providerEnvironmentWithoutNames(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  names: ReadonlySet<string>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return (environment ?? []).filter((variable) => !names.has(variable.name));
}

export function nextProviderEnvironmentWithFieldValue(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  field: ProviderEnvironmentFieldDefinition,
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
        sensitive: field.sensitive ?? variable.sensitive,
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
  const customModels = input.customModels.map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    isCustom: true,
    capabilities:
      entry.capabilities ?? liveCustomModelsBySlug.get(entry.slug)?.capabilities ?? null,
  }));
  return [...serverModels, ...customModels];
}

function ProviderAuthEmail(props: { readonly email: string | undefined }) {
  const email = props.email?.trim();
  if (!email) return null;

  return (
    <RedactedSensitiveText
      value={email}
      ariaLabel="Toggle account email visibility"
      revealTooltip="Click to reveal email"
      hideTooltip="Click to hide email"
      className="max-w-full truncate"
    />
  );
}

function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
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
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
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

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Environment variables</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() =>
            setRows([
              ...rows,
              {
                id: nextEnvironmentVariableDraftId(),
                name: "",
                value: "",
                sensitive: true,
              },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add variables to pass API keys, base URLs, or other per-instance CLI settings.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/70">
          <Table>
            <TableHeader className="bg-muted/25 text-[11px] text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead>Variable</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-20">Sensitive</TableHead>
                <TableHead className="w-12 text-right">
                  <span className="sr-only">Options</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((variable, index) => (
                <TableRow
                  key={variable.id}
                  className="border-border/60 odd:bg-muted/20 even:bg-background/20"
                >
                  <TableCell>
                    <DraftInput
                      value={variable.name}
                      onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                      placeholder="VARIABLE_NAME"
                      spellCheck={false}
                      aria-label={`Environment variable name ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell>
                    <DraftInput
                      value={variable.valueRedacted ? "" : variable.value}
                      onCommit={(value) => updateVariable(variable.id, { value })}
                      type={variable.sensitive ? "password" : undefined}
                      autoComplete="off"
                      placeholder={
                        variable.valueRedacted
                          ? "Stored secret - enter a new value to replace"
                          : "Value"
                      }
                      spellCheck={false}
                      aria-label={`Environment variable value ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell className="w-20">
                    <div className="flex h-8 items-center justify-center">
                      <Checkbox
                        checked={variable.sensitive}
                        onCheckedChange={(checked) => {
                          const sensitive = Boolean(checked);
                          updateVariable(variable.id, {
                            sensitive,
                            ...(sensitive && variable.valueRedacted === undefined
                              ? {}
                              : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                          });
                        }}
                        aria-label={`Mark environment variable ${variable.name || index + 1} as sensitive`}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="w-12">
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={() => removeVariable(variable.id)}
                        aria-label={`Remove environment variable ${variable.name || index + 1}`}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <span className="text-xs text-muted-foreground">
        Sensitive values are stored separately and are not returned to the app after saving.
      </span>
    </div>
  );
}

function ProviderEnvironmentFieldRow(props: {
  readonly field: ProviderEnvironmentFieldDefinition;
  readonly variable: ProviderInstanceEnvironmentVariable | undefined;
  readonly idPrefix: string;
  readonly onCommit: (field: ProviderEnvironmentFieldDefinition, value: string) => void;
  readonly onRemove: (field: ProviderEnvironmentFieldDefinition) => void;
}) {
  const inputId = `${props.idPrefix}-environment-${props.field.name}`;
  const value = props.variable?.valueRedacted ? "" : (props.variable?.value ?? "");
  const placeholder = props.variable?.valueRedacted
    ? "Stored secret - enter a new value to replace"
    : props.field.placeholder;

  return (
    <label htmlFor={inputId} className="block">
      <span className="text-xs font-medium text-foreground">{props.field.label}</span>
      <div className="mt-1.5 flex min-w-0 items-center gap-2">
        <DraftInput
          id={inputId}
          className="min-w-0 flex-1"
          type={props.field.sensitive === false ? undefined : "password"}
          autoComplete="off"
          value={value}
          onCommit={(next) => props.onCommit(props.field, next)}
          placeholder={placeholder}
          spellCheck={false}
        />
        {props.variable ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => props.onRemove(props.field)}
            aria-label={`Clear ${props.field.label}`}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {props.field.description ? (
        <span className="mt-1 block text-xs text-muted-foreground">{props.field.description}</span>
      ) : null}
    </label>
  );
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly isExpanded: boolean;
  readonly onExpandedChange: (open: boolean) => void;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Pass `undefined` to hide the delete button entirely. Built-in default
   * instance slots use `undefined` — they can't be deleted without losing
   * the slot, and their "reset to defaults" affordance lives on an outer
   * reset button instead. Explicit `| undefined` in the type accommodates
   * `exactOptionalPropertyTypes: true`, where an absent key and
   * `{ onDelete: undefined }` are treated as distinct shapes.
   */
  readonly onDelete?: (() => void) | undefined;
  /**
   * Optional outer reset button rendered next to the driver icon. Built-in
   * default slots supply a reset-to-factory control here; custom instances
   * omit it.
   */
  readonly headerAction?: ReactNode | undefined;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
}

/**
 * A single configured provider-instance row in the Providers settings
 * section. Used for every row — both the built-in default instance for a
 * driver (rendered with `onDelete` omitted) and user-authored custom
 * instances (`onDelete` supplied). The only UI difference between the two
 * is whether the trash button is visible; every other field (display
 * name, config fields, models) behaves identically.
 *
 * Behavior notes:
 *   - `liveProvider` is matched by the caller via `instanceId`; when no
 *     match is available (e.g. the server hasn't probed yet, or the
 *     driver is not shipped by the current build) the card still renders
 *     with a neutral "checking" summary.
 *   - Unknown drivers (`driverOption === undefined`) get a read-only
 *     notice instead of editable fields, so fork instances round-trip
 *     without accidentally destroying their config.
 *   - The enabled Switch writes to the envelope's `instance.enabled`
 *     field; the server's registry consults this at `entry.enabled ?? true`
 *     before materializing the instance, and the probe also checks its
 *     driver-specific `config.enabled`. We treat the envelope flag as the
 *     single source of truth from the UI — built-in cards used to write
 *     the inner flag, but on the promotion-to-instance path every edit
 *     flows through the envelope.
 */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  isExpanded,
  onExpandedChange,
  onUpdate,
  onDelete,
  headerAction,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onRunUpdate,
  isUpdating = false,
}: ProviderInstanceCardProps) {
  const [activeTab, setActiveTab] = useState<"configuration" | "models">("configuration");
  const enabled = resolveProviderInstanceEnabled(instance);
  // A locally disabled provider reads "Disabled" with a muted dot even if its
  // last server status is stale. Enabled providers use the server status.
  const statusKey: ProviderStatusKey = enabled
    ? ((liveProvider?.status as ProviderStatusKey | undefined) ?? "warning")
    : "disabled";
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const summary = enabled
    ? getProviderSummary(liveProvider)
    : { headline: "Disabled", detail: null };
  const authEmail = liveProvider?.auth.email?.trim();
  // The editor header folds the account email into the status line —
  // "Authenticated as <email> · <plan>" — with the email redacted until its
  // reveal toggle is clicked.
  const isAuthenticated = enabled && liveProvider?.auth.status === "authenticated";
  const authLabel =
    enabled && liveProvider?.auth.status === "authenticated"
      ? (liveProvider.auth.label ?? liveProvider.auth.type ?? null)
      : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const FallbackIconComponent = driverOption?.icon;
  const displayName =
    instance.displayName?.trim() || driverOption?.label || String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  const { copyToClipboard } = useCopyToClipboard<{ providerName: string }>({
    onCopy: ({ providerName }) => {
      toastManager.add({
        type: "success",
        title: `${providerName} update command copied`,
        description: "Run it in a terminal when you are ready to update.",
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${providerName} update command`,
          description: error.message,
        }),
      );
    },
  });

  // Narrow `instance.driver` for callers that key on the closed
  // `ProviderDriverKind` union (e.g. `normalizeModelSlug`'s alias table). Custom
  // fork drivers pass through as `null` and those callers fall back to
  // verbatim behaviour.
  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;

  const customModels = readConfigStringArray(instance.config, "customModels");
  const environmentFields = driverOption?.environmentFields ?? [];
  const environmentFieldNames = new Set(environmentFields.map((field) => field.name));
  const genericEnvironment = providerEnvironmentWithoutNames(
    instance.environment,
    environmentFieldNames,
  );
  // Server-returned models may lag behind settings writes. Treat probe
  // models as the source for built-ins only; custom rows come directly
  // from the current instance config so add/remove reflects immediately.
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

  const updateCustomModels = (next: ReadonlyArray<CustomModelDefinition>) => {
    const nextConfig = nextConfigBlobWithValue(
      instance.config,
      "customModels",
      next.map(toCustomModelSetting),
    );
    const { config: _omit, ...rest } = instance;
    onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
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

  const updateGenericEnvironment = (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => {
    const dedicatedEnvironment = (instance.environment ?? []).filter((variable) =>
      environmentFieldNames.has(variable.name),
    );
    updateEnvironment([...dedicatedEnvironment, ...environment]);
  };

  const updateEnvironmentField = (field: ProviderEnvironmentFieldDefinition, value: string) => {
    updateEnvironment(nextProviderEnvironmentWithFieldValue(instance.environment, field, value));
  };

  const removeEnvironmentField = (field: ProviderEnvironmentFieldDefinition) => {
    updateEnvironment(providerEnvironmentWithoutNames(instance.environment, new Set([field.name])));
  };

  const titleIconNode = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={displayName}
      accentColor={accentColor}
      showBadge={Boolean(accentColor)}
      statusDotClassName={statusStyle.dot}
      indicatorBackground="var(--card)"
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
    />
  ) : FallbackIconComponent ? (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card",
          statusStyle.dot,
        )}
        aria-hidden
      />
    </span>
  ) : (
    <span className={cn("size-2 shrink-0 rounded-full", statusStyle.dot)} />
  );

  const titleHeadNode = (
    <>
      {titleIconNode}
      <h3 className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
        {displayName}
      </h3>
      {String(instanceId) !== String(instance.driver) ? (
        <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
          {instanceId}
        </code>
      ) : null}
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
    </>
  );

  const titleTailNode = (
    <>
      {headerAction ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          {headerAction}
        </span>
      ) : null}
      {onDelete ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={onDelete}
                  aria-label={`Delete provider instance ${instanceId}`}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="top">Delete instance</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </>
  );

  const authRowNode = (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[13px] leading-[1.45] text-muted-foreground/80">
      {hasAuthenticatedEmail ? (
        <>
          <span>Authenticated as</span>
          <ProviderAuthEmail email={authEmail} />
          {authenticatedDetail ? <span>· {authenticatedDetail}</span> : null}
        </>
      ) : (
        <>
          <span>{summary.headline}</span>
          <ProviderAuthEmail email={authEmail} separator prefix="Email" />
        </>
      )}
      {summary.detail ? <span>- {summary.detail}</span> : null}
    </p>
  );

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;

  // Healthy and disabled rows read fine from their text; only trouble gets a dot.
  const statusDotNode =
    statusKey === "warning" || statusKey === "error" ? (
      <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} aria-hidden />
    ) : null;
  const statusHeadlineNode = <span>{summary.headline}</span>;
  // Trouble states carry the server's explanation (a failed probe, a shadow
  // home entry that is not a symlink, a missing binary). Show it wherever the
  // headline shows so the user can act without opening the editor.
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const statusLineClassName =
    "flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-[1.45] text-muted-foreground/80";

  if (mode === "list") {
    return (
      <div
        className={cn(
          // Sidebar-style selection with a fixed row height so the list stays
          // even; the status line clamps to two lines instead of growing.
          "group flex h-19 items-start gap-3 rounded-md px-3 py-2 transition-colors",
          // Foreground-alpha tint so the fill reads the same in light and dark themes.
          selected ? "bg-foreground/8" : "hover:bg-foreground/4",
        )}
      >
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-sm text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
            !enabled && !selected && "opacity-60 group-hover:opacity-100",
          )}
          onClick={onSelect}
          aria-pressed={selected}
        >
          {titleIconNode}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              {String(instanceId) !== String(instance.driver) ? (
                <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {versionLabel ? (
                <code className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {versionLabel}
                </code>
              ) : null}
              {versionAdvisory ? (
                <span role="img" aria-label="Update available" className="inline-flex shrink-0">
                  <ArrowUpCircleIcon className="size-3.5 text-muted-foreground" />
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
              {statusDotNode ? (
                <span className="flex h-[1.45em] shrink-0 items-center">{statusDotNode}</span>
              ) : null}
              <span className="line-clamp-2 [overflow-wrap:anywhere]">
                {summary.headline}
                {needsAttention && summary.detail ? ` · ${summary.detail}` : null}
              </span>
            </span>
          </span>
        </button>
        <span className="flex h-5 shrink-0 items-center">
          <Switch
            checked={enabled}
            disabled={readOnly}
            onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
            aria-label={`Enable ${displayName}`}
          />
        </span>
      </div>
    );
  }
  return (
    <div className="min-w-0 lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="flex min-h-16 shrink-0 items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {titleHeadNode}
            {versionCodeNode}
            {/*
              Only the write actions go inert on read-only sessions; the
              status line below keeps its email reveal clickable.
            */}
            <span
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={cn("inline-flex items-center gap-2", readOnly && "opacity-50")}
            >
              {versionAdvisory ? (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className={cn(
                          "size-5 rounded-sm p-0",
                          versionAdvisory.emphasis === "strong"
                            ? "text-warning hover:text-warning"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        aria-label="Update available — view details"
                      >
                        <ArrowUpCircleIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <PopoverPopup
                    side="bottom"
                    align="start"
                    className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
                  >
                    <div className="grid min-w-0 gap-3">
                      <div className="grid gap-0.5">
                        <p className="text-[13px] font-semibold leading-tight text-foreground">
                          Update available
                        </p>
                        <p
                          className={cn(
                            "text-xs leading-snug",
                            versionAdvisory.emphasis === "strong"
                              ? "text-warning"
                              : "text-muted-foreground",
                          )}
                        >
                          {versionAdvisory.detail}
                        </p>
                      </div>
                      {onRunUpdate ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="w-full"
                          disabled={isUpdating}
                          onClick={onRunUpdate}
                        >
                          {isUpdating ? <LoaderIcon className="animate-spin" /> : <DownloadIcon />}
                          {isUpdating ? "Updating" : "Update now"}
                        </Button>
                      ) : null}
                      {onRunUpdate && updateCommand ? (
                        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          <span aria-hidden className="h-px flex-1 bg-border" />
                          or, update manually using
                          <span aria-hidden className="h-px flex-1 bg-border" />
                        </div>
                      ) : null}
                      {updateCommand ? (
                        <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
                          <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
                            <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-[11px] text-foreground">
                              {updateCommand}
                            </code>
                          </ScrollArea>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                                  onClick={() =>
                                    copyToClipboard(updateCommand, {
                                      providerName: displayName,
                                    })
                                  }
                                  aria-label="Copy update command"
                                >
                                  <CopyIcon className="size-3" />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">Copy command</TooltipPopup>
                          </Tooltip>
                        </div>
                      ) : null}
                    </div>
                  </PopoverPopup>
                </Popover>
              ) : null}
              {titleTailNode}
            </span>
          </div>
          <p className={statusLineClassName}>
            {statusDotNode}
            {isAuthenticated && authEmail ? (
              <>
                <span>Authenticated as</span>
                <ProviderAuthEmail email={authEmail} />
                {authLabel ? <span>· {authLabel}</span> : null}
              </>
            ) : (
              statusHeadlineNode
            )}
            {summary.detail && !needsAttention ? <span>· {summary.detail}</span> : null}
          </p>
          {summary.detail && needsAttention ? (
            <p className="text-[13px] leading-[1.45] text-muted-foreground/80 [overflow-wrap:anywhere]">
              {summary.detail}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex h-11 shrink-0 border-b border-border/70 px-1">
        <button
          type="button"
          aria-pressed={visibleTab === "configuration"}
          className={providerSettingsTabClassName(visibleTab === "configuration")}
          onClick={() => setActiveTab("configuration")}
        >
          Configuration
        </button>
        {driverOption !== undefined ? (
          <button
            type="button"
            aria-pressed={visibleTab === "models"}
            className={providerSettingsTabClassName(visibleTab === "models")}
            onClick={() => setActiveTab("models")}
          >
            Models
          </button>
        ) : null}
      </div>

      <div className="lg:min-h-0 lg:flex-1">
        <ScrollArea
          scrollFade
          chainVerticalScroll
          className="lg:h-full"
          hidden={visibleTab !== "configuration"}
        >
          <div
            inert={readOnly}
            aria-disabled={readOnly || undefined}
            className={cn("space-y-5 px-4 py-5", readOnly && "opacity-50 select-none")}
          >
            <div>
              <label htmlFor={`provider-instance-${instanceId}-display-name`} className="block">
                <span className="text-xs font-medium text-foreground">Display name</span>
                <DraftInput
                  id={`provider-instance-${instanceId}-display-name`}
                  className="mt-1.5"
                  value={instance.displayName ?? ""}
                  onCommit={updateDisplayName}
                  placeholder={driverOption?.label ?? "Instance label"}
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Optional label shown in the provider list.
                </span>
              </label>
            </div>

            <div>
              <ProviderAccentColorPicker
                displayName={displayName}
                value={accentColor}
                onCommit={updateAccentColor}
                commitDelayMs={120}
                description="Used to distinguish this instance in picker rails and model lists."
              />
            </div>

            <div>
              <ProviderEnvironmentSection
                environment={instance.environment ?? []}
                onChange={updateEnvironment}
              />
            </div>

            {driverOption ? (
              <ProviderSettingsForm
                definition={driverOption}
                value={instance.config}
                idPrefix={`provider-instance-${instanceId}`}
                variant="card"
                onChange={updateConfig}
              />
            ) : null}

            {driverOption === undefined ? (
              <div>
                <p className="text-xs text-muted-foreground">
                  This instance uses a driver (
                  <code className="text-foreground">{String(instance.driver)}</code>) that is not
                  shipped with the current build. Configuration values are preserved but cannot be
                  edited from this surface.
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        {driverOption !== undefined ? (
          <div
            inert={readOnly}
            aria-disabled={readOnly || undefined}
            className={cn("px-4 py-5 lg:h-full lg:min-h-0", readOnly && "opacity-50 select-none")}
            hidden={visibleTab !== "models"}
          >
            <ProviderModelsSection
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
              onModelOrderChange={onModelOrderChange}
            />
          </div>
        </div>
      </div>

      <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="space-y-5 px-3 pb-4 pt-2 sm:px-4">
            <div>
              <label htmlFor={`provider-instance-${instanceId}-display-name`} className="block">
                <span className="text-xs font-medium text-foreground">Display name</span>
                <DraftInput
                  id={`provider-instance-${instanceId}-display-name`}
                  className="mt-1.5"
                  value={instance.displayName ?? ""}
                  onCommit={updateDisplayName}
                  placeholder={driverOption?.label ?? "Instance label"}
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Optional label shown in the provider list.
                </span>
              </label>
            </div>

            <div>
              <ProviderAccentColorPicker
                displayName={displayName}
                value={accentColor}
                onCommit={updateAccentColor}
                commitDelayMs={120}
                description="Used to distinguish this instance in picker rails and model lists."
              />
            </div>

            <div className="border-t border-border/60 px-4 py-3 sm:px-5">
              {environmentFields.length > 0 ? (
                <div className="mb-4 grid gap-3">
                  {environmentFields.map((field) => (
                    <ProviderEnvironmentFieldRow
                      key={field.name}
                      field={field}
                      variable={readProviderEnvironmentVariable(instance.environment, field.name)}
                      idPrefix={`provider-instance-${instanceId}`}
                      onCommit={updateEnvironmentField}
                      onRemove={removeEnvironmentField}
                    />
                  ))}
                </div>
              ) : null}
              <ProviderEnvironmentSection
                environment={genericEnvironment}
                onChange={updateGenericEnvironment}
              />
            </div>

            {driverOption ? (
              <ProviderSettingsForm
                definition={driverOption}
                value={instance.config}
                idPrefix={`provider-instance-${instanceId}`}
                variant="card"
                onChange={updateConfig}
              />
            ) : null}

            {driverOption !== undefined ? (
              <ProviderModelsSection
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
                onModelOrderChange={onModelOrderChange}
              />
            ) : (
              <div>
                <p className="text-xs text-muted-foreground">
                  This instance uses a driver (
                  <code className="text-foreground">{String(instance.driver)}</code>) that is not
                  shipped with the current build. Configuration values are preserved but cannot be
                  edited from this surface.
                </p>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
