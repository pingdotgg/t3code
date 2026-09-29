"use client";

import { Spinner } from "~/components/ui/spinner";

import {
  AlertTriangleIcon,
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  LockIcon,
  LockOpenIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "@t3tools/i18n/react";
import type { TFunction } from "@t3tools/i18n";
import {
  isProviderDriverKind,
  resolveProviderInstanceEnabled,
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
import { DraftInput } from "../ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon, providerInstanceInitials } from "../chat/ProviderInstanceIcon";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderSummary,
  getProviderVersionLabel,
  type ProviderStatusKey,
} from "./providerStatus";

type SettingsTranslate = TFunction<"settings">;

function localizedProviderHeadline(headline: string, t: SettingsTranslate): string {
  if (headline.startsWith("Authenticated · ")) {
    return `${t("providerInstance.authenticated")} · ${headline.slice("Authenticated · ".length)}`;
  }
  switch (headline) {
    case "Checking provider status":
      return t("providerInstance.checkingStatus");
    case "Disabled":
      return t("providerInstance.disabled");
    case "Not found":
      return t("providerInstance.notFound");
    case "Not authenticated":
      return t("providerInstance.notAuthenticated");
    case "Needs attention":
      return t("providerInstance.needsAttention");
    case "Unavailable":
      return t("providerInstance.unavailable");
    case "Authenticated":
      return t("providerInstance.authenticated");
    case "Available":
      return t("providerInstance.available");
    default:
      return headline;
  }
}

function localizedProviderDetail(detail: string | null, t: SettingsTranslate): string | null {
  switch (detail) {
    case "Waiting for the server to report installation and authentication details.":
      return t("providerInstance.waitingForStatus");
    case "This provider is installed but disabled for new sessions in T3 Code.":
      return t("providerInstance.disabledDescription");
    case "CLI not detected on PATH.":
      return t("providerInstance.cliNotDetected");
    case "The provider is installed, but the server could not fully verify it.":
      return t("providerInstance.installationNotVerified");
    case "The provider failed its startup checks.":
      return t("providerInstance.startupChecksFailed");
    default:
      return detail;
  }
}

function localizedVersionAdvisoryText(value: string, t: SettingsTranslate): string {
  switch (value) {
    case "Limited support":
      return t("providerInstance.limitedSupport");
    case "Incompatible":
      return t("providerInstance.incompatible");
    case "Unsupported":
      return t("providerInstance.unsupported");
    case "Unsupported version":
      return t("providerInstance.unsupportedVersion");
    case "Known broken version":
      return t("providerInstance.brokenVersion");
    case "Update available":
      return t("providerInstance.updateAvailable");
    case "Update for full support.":
      return t("providerInstance.updateForFullSupport");
    case "Update available: install the latest provider version.":
      return t("providerInstance.installLatestVersion");
    default: {
      const supportedVersion = /^Use (.+) for full support\.$/u.exec(value)?.[1];
      if (supportedVersion) {
        return t("providerInstance.useVersionForFullSupport", { version: supportedVersion });
      }
      const updateVersion = /^Update available: install (.+)\.$/u.exec(value)?.[1];
      if (updateVersion) {
        return t("providerInstance.installAvailableVersion", { version: updateVersion });
      }
      return value;
    }
  }
}

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
        variable.value === other.value &&
        variable.sensitive === other.sensitive &&
        variable.valueRedacted === other.valueRedacted
      );
    })
  );
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

/**
 * Custom rows come from current settings so name/descriptor edits show
 * instantly; a bare entry falls back to the live row's driver-default
 * capabilities (the server fills those in on its next probe).
 */
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
  const { t } = useTranslation("settings");
  const email = props.email?.trim();
  if (!email) return null;

  return (
    <RedactedSensitiveText
      value={email}
      ariaLabel={t("providerInstance.toggleEmailVisibility")}
      revealTooltip={t("providerInstance.revealEmail")}
      hideTooltip={t("providerInstance.hideEmail")}
      className="max-w-full truncate"
    />
  );
}

function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const { t } = useTranslation("settings");
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );
  const previousEnvironmentRef = useRef(props.environment);
  const lastPublishedEnvironmentRef = useRef<
    ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined
  >(undefined);

  useEffect(() => {
    const previousEnvironment = previousEnvironmentRef.current;
    const lastPublishedEnvironment = lastPublishedEnvironmentRef.current;
    previousEnvironmentRef.current = props.environment;
    lastPublishedEnvironmentRef.current = undefined;
    if (
      previousEnvironment === props.environment ||
      providerEnvironmentsEqual(previousEnvironment, props.environment) ||
      (lastPublishedEnvironment !== undefined &&
        providerEnvironmentsEqual(lastPublishedEnvironment, props.environment))
    ) {
      return;
    }
    setRows(props.environment.map(makeEnvironmentDraftRow));
  }, [props.environment]);

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
    lastPublishedEnvironmentRef.current = published;
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
      title={t("providerInstance.variables")}
      description={t("providerInstance.variablesDescription")}
      control={
        <Button type="button" size="sm" variant="outline" onClick={addVariable}>
          <PlusIcon className="size-3" />
          {t("providerInstance.addVariable")}
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((variable, index) => (
            <div key={variable.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <DraftInput
                size="sm"
                font="mono"
                className="w-full min-w-0 sm:w-44 sm:shrink-0"
                value={variable.name}
                onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                placeholder={t("providerInstance.variableNamePlaceholder")}
                spellCheck={false}
                aria-label={t("providerInstance.variableName", { number: index + 1 })}
              />
              <span className="hidden text-xs text-muted-foreground sm:inline" aria-hidden>
                =
              </span>
              <DraftInput
                size="sm"
                font="mono"
                className="min-w-0 flex-1"
                value={variable.valueRedacted ? "" : variable.value}
                onCommit={(value) => updateVariable(variable.id, { value })}
                type={variable.sensitive ? "password" : undefined}
                autoComplete="off"
                placeholder={
                  variable.valueRedacted
                    ? t("providerInstance.replaceStoredSecret")
                    : t("providerInstance.valuePlaceholder")
                }
                spellCheck={false}
                aria-label={t("providerInstance.variableValue", { number: index + 1 })}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
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
                      aria-label={t("providerInstance.markVariableSensitive", {
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
                />
                <TooltipPopup side="top">
                  {variable.sensitive
                    ? t("providerInstance.sensitiveStoredSeparately")
                    : t("providerInstance.plainText")}
                </TooltipPopup>
              </Tooltip>
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() => removeVariable(variable.id)}
                aria-label={t("providerInstance.removeVariable", {
                  name: variable.name || index + 1,
                })}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {t("providerInstance.sensitiveDescription")}
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly mode: "list" | "editor";
  readonly selected?: boolean | undefined;
  readonly onSelect?: (() => void) | undefined;
  readonly readOnly?: boolean | undefined;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Pass `undefined` to hide the delete footer entirely. Built-in default
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
  readonly setup?: ReactNode;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly onInstallRecommended?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
}

/**
 * Renders one provider instance as either a compact selectable list row or
 * the full editor shown beside that list. Both modes use the same enabled
 * state and provider metadata.
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
 *     field, which is the single enabled flag: the server folds any legacy
 *     driver-specific `config.enabled` into the envelope on load and both
 *     sides resolve through `resolveProviderInstanceEnabled` (an explicit
 *     false wins, then envelope, then config, then the driver default).
 */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  mode,
  selected = false,
  onSelect,
  readOnly = false,
  onUpdate,
  onDelete,
  headerAction,
  setup,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onRunUpdate,
  onInstallRecommended,
  isUpdating = false,
}: ProviderInstanceCardProps) {
  const { t } = useTranslation("settings");
  const enabled = resolveProviderInstanceEnabled(instance);
  const compatibility = enabled ? liveProvider?.compatibilityAdvisory : undefined;
  // A locally disabled provider reads "Disabled" with a muted dot even if its
  // last server status is stale. Enabled providers use the server status.
  const statusKey: ProviderStatusKey = enabled
    ? ((liveProvider?.status as ProviderStatusKey | undefined) ?? "warning")
    : "disabled";
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const rawSummary = enabled
    ? getProviderSummary(liveProvider)
    : { headline: "Disabled", detail: null };
  const summary = {
    headline: localizedProviderHeadline(rawSummary.headline, t),
    detail: localizedProviderDetail(rawSummary.detail, t),
  };
  const authEmail = liveProvider?.auth.email?.trim();
  const isAuthenticated = enabled && liveProvider?.auth.status === "authenticated";
  const authLabel =
    enabled && liveProvider?.auth.status === "authenticated"
      ? (liveProvider.auth.label ?? liveProvider.auth.type ?? null)
      : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const rawVersionAdvisory = getProviderVersionAdvisoryPresentation(
    liveProvider?.versionAdvisory,
    liveProvider?.compatibilityAdvisory,
    enabled,
  );
  const versionAdvisory = rawVersionAdvisory
    ? {
        ...rawVersionAdvisory,
        title: localizedVersionAdvisoryText(rawVersionAdvisory.title, t),
        detail: localizedVersionAdvisoryText(rawVersionAdvisory.detail, t),
      }
    : null;
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const hasCompatibilityWarning =
    compatibility !== undefined &&
    compatibility.status !== "supported" &&
    compatibility.status !== "unknown";
  const VersionAdvisoryIcon = hasCompatibilityWarning ? AlertTriangleIcon : ArrowUpCircleIcon;
  const onRunVersionAction = versionAdvisory?.targetVersion ? onInstallRecommended : onRunUpdate;
  const FallbackIconComponent = driverOption?.icon;
  const displayName =
    instance.displayName?.trim() || driverOption?.label || String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  const { copyToClipboard } = useCopyToClipboard<{ providerName: string }>({
    onCopy: ({ providerName }) => {
      toastManager.add({
        type: "success",
        title: t("providerInstance.updateCommandCopied", { provider: providerName }),
        description: t("providerInstance.updateCommandCopiedDescription"),
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("providerInstance.couldNotCopyUpdateCommand", { provider: providerName }),
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
  const customModels =
    instance.driver === "antigravity" ? [] : readConfigCustomModels(instance.config);
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

  const titleIconNode = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={displayName}
      accentColor={accentColor}
      showBadge={Boolean(accentColor)}
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
    />
  ) : FallbackIconComponent ? (
    <span className="inline-flex size-5 shrink-0 items-center justify-center">
      <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
    </span>
  ) : (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center text-3xs font-semibold leading-none text-foreground/80"
      aria-hidden
    >
      {providerInstanceInitials(displayName)}
    </span>
  );

  const titleTailNode = headerAction ? (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{headerAction}</span>
  ) : null;

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;

  // Healthy and disabled rows read fine from their text; only trouble gets a dot.
  const statusDotNode =
    statusKey === "warning" || statusKey === "error" ? (
      <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} aria-hidden />
    ) : null;
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const statusDiagnostic = hasCompatibilityWarning && needsAttention ? summary.detail : null;
  // Keep compatibility copy compact; the version popover carries the explanation.
  const inlineStatusDetail = hasCompatibilityWarning
    ? compatibility?.status === "broken"
      ? t("providerInstance.incompatible")
      : compatibility?.status === "unsupported"
        ? t("providerInstance.unsupported")
        : t("providerInstance.limitedSupport")
    : summary.detail;
  const editorStatusNode =
    isAuthenticated && authEmail ? (
      <>
        {needsAttention ? statusDotNode : null}
        <span>{t("providerInstance.authenticatedAs")}</span>
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
  if (mode === "list") {
    return (
      <div
        data-slot="settings-row"
        className={cn(
          "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4",
          selected ? "bg-muted/45" : "hover:bg-muted/25",
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
            className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onSelect}
            aria-label={t("providerInstance.selectProvider", { provider: displayName })}
            aria-pressed={selected}
          />
          {titleIconNode}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              {String(instanceId) !== String(instance.driver) ? (
                <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-3xs text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {versionLabel ? (
                <code className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {versionLabel}
                </code>
              ) : null}
              {versionAdvisory ? (
                hasCompatibilityWarning ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          tabIndex={0}
                          role="img"
                          aria-label={versionAdvisory.title}
                          className="pointer-events-auto relative inline-flex shrink-0 text-warning"
                        >
                          <VersionAdvisoryIcon className="size-3.5" />
                        </span>
                      }
                    />
                    <TooltipPopup side="top">{versionAdvisory.detail}</TooltipPopup>
                  </Tooltip>
                ) : updateCommand ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-micro"
                          variant="ghost-muted"
                          className="pointer-events-auto relative shrink-0"
                          aria-label={t("providerInstance.copyProviderUpdateCommand", {
                            provider: displayName,
                          })}
                          onClick={() =>
                            copyToClipboard(updateCommand, { providerName: displayName })
                          }
                        >
                          <ArrowUpCircleIcon className="size-3.5" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">
                      {t("providerInstance.copyUpdateCommand")}
                    </TooltipPopup>
                  </Tooltip>
                ) : (
                  <span
                    role="img"
                    aria-label={t("providerInstance.updateAvailableLabel")}
                    className="inline-flex shrink-0"
                  >
                    <ArrowUpCircleIcon className="size-3.5 text-muted-foreground" />
                  </span>
                )
              ) : null}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-xs leading-normal text-muted-foreground/80">
              {statusDotNode ? (
                <span className="flex h-[1.45em] shrink-0 items-center">{statusDotNode}</span>
              ) : null}
              <ProviderStatusDiagnostic detail={statusDiagnostic}>
                <span
                  tabIndex={statusDiagnostic ? 0 : undefined}
                  className="pointer-events-auto line-clamp-2 [overflow-wrap:anywhere]"
                >
                  {summary.headline}
                  {needsAttention && inlineStatusDetail ? ` · ${inlineStatusDetail}` : null}
                </span>
              </ProviderStatusDiagnostic>
            </span>
          </span>
        </div>
        <span className="flex h-5 shrink-0 items-center">
          <Switch
            checked={enabled}
            disabled={readOnly}
            onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
            aria-label={t("providerInstance.enableProvider", { provider: displayName })}
          />
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
      <span
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={cn("inline-flex items-center gap-1", readOnly && "opacity-50")}
      >
        {versionAdvisory ? (
          <Popover>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={t("providerInstance.viewVersionDetails", {
                          title: versionAdvisory.title,
                        })}
                      >
                        <VersionAdvisoryIcon
                          className={cn(hasCompatibilityWarning && "text-warning")}
                        />
                      </Button>
                    }
                  />
                }
              />
              <TooltipPopup side="top">{versionAdvisory.title}</TooltipPopup>
            </Tooltip>
            <PopoverPopup side="bottom" align="end" width="md">
              <div className="grid min-w-0 gap-3">
                <div className="grid gap-0.5">
                  <p className="text-sm font-semibold leading-tight text-foreground">
                    {versionAdvisory.title}
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
                      ? t("providerInstance.updating")
                      : versionAdvisory.targetVersion
                        ? t("providerInstance.installVersion", {
                            version:
                              getProviderVersionLabel(versionAdvisory.targetVersion) ??
                              versionAdvisory.targetVersion ??
                              "",
                          })
                        : t("providerInstance.updateNow")}
                  </Button>
                ) : null}
                {onRunVersionAction && updateCommand ? (
                  <div className="flex items-center gap-2 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                    <span aria-hidden className="h-px flex-1 bg-border" />
                    {t("providerInstance.manualUpdateDivider")}
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
                            onClick={() =>
                              copyToClipboard(updateCommand, { providerName: displayName })
                            }
                            aria-label={t("providerInstance.copyUpdateCommand")}
                          >
                            <CopyIcon className="size-3" />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">{t("providerInstance.copyCommand")}</TooltipPopup>
                    </Tooltip>
                  </div>
                ) : null}
              </div>
            </PopoverPopup>
          </Popover>
        ) : null}
        {titleTailNode}
        {onDelete ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-destructive"
            disabled={readOnly}
            onClick={onDelete}
            aria-label={t("providerInstance.deleteInstance", { instance: instanceId })}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </span>
    </div>
  );

  return (
    <>
      <SettingsSection title={displayName} icon={titleIconNode} headerAction={editorHeaderAction}>
        <SettingsRow
          title={t("providerInstance.displayName")}
          status={
            <ProviderStatusDiagnostic detail={statusDiagnostic}>
              <div
                tabIndex={statusDiagnostic ? 0 : undefined}
                className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
              >
                {editorStatusNode}
              </div>
            </ProviderStatusDiagnostic>
          }
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
                commitDelayMs={120}
              />
              <DraftInput
                id={`provider-instance-${instanceId}-display-name`}
                size="sm"
                className="min-w-0 flex-1 @min-[32rem]/settings-row:w-56"
                value={instance.displayName ?? ""}
                onCommit={updateDisplayName}
                placeholder={driverOption?.label ?? t("providerInstance.instanceLabel")}
                spellCheck={false}
              />
            </div>
          }
        />
      </SettingsSection>

      {setup ? (
        <SettingsSection title={t("providerInstance.setup")}>{setup}</SettingsSection>
      ) : null}

      <SettingsSection
        title={t("providerInstance.runtime")}
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        {driverOption ? (
          <ProviderSettingsForm
            definition={driverOption}
            value={instance.config}
            idPrefix={`provider-instance-${instanceId}`}
            variant="settings"
            onChange={updateConfig}
          />
        ) : (
          <SettingsRow
            title={t("providerInstance.driver")}
            description={t("providerInstance.unsupportedDriverDescription", {
              driver: String(instance.driver),
            })}
          />
        )}
      </SettingsSection>

      <SettingsSection
        title={t("providerInstance.environment")}
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        <ProviderEnvironmentSection
          environment={instance.environment ?? []}
          onChange={updateEnvironment}
        />
      </SettingsSection>

      {driverOption !== undefined ? (
        <SettingsSection
          title={t("providerInstance.models")}
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          <div className="px-3 py-3 sm:px-4">
            <p className="mb-3 text-xs text-muted-foreground">
              {t("providerInstance.modelsDescription")}
            </p>
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
        </SettingsSection>
      ) : null}
    </>
  );
}
