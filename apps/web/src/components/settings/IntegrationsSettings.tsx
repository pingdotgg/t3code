import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { DeviceHostUpdates } from "../device/DeviceHostUpdates";
import { useT } from "../../hooks/useI18n";
import { DeviceToolVersions } from "../device/DeviceToolVersions";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { DeviceSourcesSettings } from "./DeviceSourcesSettings";
import {
  AuthSettingsWriteScope,
  BrowserImportFailureReason,
  BROWSER_PROFILE_MAX_COUNT,
  type BrowserLinkTarget,
  type BrowserProfile,
  BrowserSearchEngine,
  BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH,
  type EnvironmentId,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  BROWSER_RECORDING_FRAME_RATES,
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_LINK_TARGET,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  DEFAULT_BROWSER_SEARCH_ENGINE,
  DEFAULT_BROWSER_VIEWPORT,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  DEFAULT_SERVER_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_ZOOM_LEVELS,
  findBrowserProfile,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  type BrowserImportSource,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
  managedCapabilityDenial,
} from "@t3tools/contracts";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { isValidSearchUrlTemplate } from "@t3tools/shared/preview";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import { MoreVertical, Plus as PlusIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";

import { ScreenRotationIcon } from "~/browser/ScreenRotationIcon";
import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import { previewBridge } from "~/components/preview/previewBridge";
import { cn, randomUUID } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError } from "~/state/query";
import { previewEnvironment } from "~/state/preview";
import { useServerConfigs } from "~/state/entities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AgentDeviceSetupStatus,
  DeviceHubSetupStatus,
  deviceHubReadiness,
} from "~/components/device/DeviceSetup";
import { isElectron } from "../../env";

import { Badge } from "../ui/badge";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { readLocalApi } from "~/localApi";

import { toastManager } from "../ui/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import {
  SettingsUnavailableGroup,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { AdvancedSettings } from "./AdvancedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { BrowserImportWizard, type WizardTarget } from "./BrowserImportWizard";
import type { ImportOutcome } from "./browserImportWizard.logic";

const FILL_VALUE = "fill";
const RESPONSIVE_VALUE = "responsive";

type BrowserProfileDataBridge = Pick<
  NonNullable<typeof previewBridge>,
  "clearCookies" | "clearCache"
>;

export interface ServerProfileData {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly clear: (environmentId: EnvironmentId, profileId: string) => Promise<void>;
}

export async function clearBrowserProfileData(
  bridge: BrowserProfileDataBridge | null,
  environmentIds: ReadonlyArray<EnvironmentId>,
  profileId: string,
  server?: ServerProfileData,
): Promise<void> {
  const desktopEnvironmentIds = bridge === null ? [] : environmentIds;
  const serverEnvironmentIds = server?.environmentIds ?? [];
  if (desktopEnvironmentIds.length === 0 && serverEnvironmentIds.length === 0) {
    throw new Error("Browser profile data is not available to clear.");
  }
  await Promise.all([
    ...desktopEnvironmentIds.flatMap((environmentId) => [
      bridge!.clearCookies(environmentId, profileId),
      bridge!.clearCache(environmentId, profileId),
    ]),
    ...serverEnvironmentIds.map((environmentId) => server!.clear(environmentId, profileId)),
  ]);
}

function browserProfileRemovalAvailable(
  bridgeAvailable: boolean,
  environmentsReady: boolean,
  environmentCount: number,
  serverBrowserCount = 0,
): boolean {
  return (bridgeAvailable || serverBrowserCount > 0) && environmentsReady && environmentCount > 0;
}

const RESPONSIVE_SEED_SIZE = { width: 1280, height: 800 } as const;

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

const APPEARANCE_LABELS: Readonly<Record<PreviewAppearancePreference, MessageKey>> = {
  system: "settings.code.browser.appearance.system",
  light: "settings.code.browser.appearance.light",
  dark: "settings.code.browser.appearance.dark",
};

/** Placeholder swapped for inline markup after translation. */
const SLOT = "\u0001";

const zoomLabel = (zoomFactor: number) => `${Math.round(zoomFactor * 100)}%`;

/** IPC carries reason tokens inside messages; treat unknown tokens as read failures without exposing raw
 * text. */
class ProfileLimitReachedError extends Schema.TaggedError<ProfileLimitReachedError>()(
  "ProfileLimitReachedError",
  {},
) {
  override get message(): string {
    return "Browser profile limit reached.";
  }
}

const isProfileLimitReachedError = Schema.is(ProfileLimitReachedError);

export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

/**
 * The desktop's refusal when the machine's managed policy forbids cookie import. IPC wraps the
 * message in its own prefixes, so the sentence is matched on the contract's wording.
 */
export const importPolicyRefusal = (cause: unknown): string | undefined => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    /The managed policy at .* importing browser cookies is not allowed\./u.exec(message)?.[0] ??
    /(?:^|: )([^:]*'s policy does not allow importing browser cookies\.)/u.exec(message)?.[1]
  );
};

async function importBrowserCookiesIntoTarget(
  bridge: NonNullable<typeof previewBridge>,
  source: BrowserImportSource,
  environmentId: EnvironmentId,
  input: { readonly sourceProfileDirectory: string; readonly target: WizardTarget },
): Promise<ImportOutcome> {
  try {
    const result = await bridge.importBrowserCookies({
      environmentId,
      sourceId: source.id,
      sourceProfileDirectory: input.sourceProfileDirectory,
      targetProfileId: input.target.profileId,
    });
    if (
      input.target.kind === "existing" &&
      !resolveBrowserProfiles(getClientSettings().browserProfiles).some(
        (profile) => profile.id === input.target.profileId,
      )
    ) {
      return { kind: "blocked", reason: "readFailed" };
    }
    let targetName: string;
    if (input.target.kind === "new") {
      if (result.imported > 0) {
        try {
          const persisted = await persistClientSettingsUpdate((current) => {
            const existing = current.browserProfiles.find(
              (profile) => profile.id === input.target.profileId,
            );
            if (existing) return current;
            // The profile cap may be reached during import; enforce it against the updater's latest settings.
            if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) {
              throw new ProfileLimitReachedError();
            }
            const taken = new Set(
              resolveBrowserProfiles(current.browserProfiles).map((profile) => profile.name),
            );
            let name = source.name;
            for (let index = 2; taken.has(name); index += 1) name = `${source.name} ${index}`;
            return {
              ...current,
              browserProfiles: [
                ...current.browserProfiles,
                { id: input.target.profileId, name, kind: "persistent" as const },
              ],
            };
          });
          targetName =
            persisted.browserProfiles.find((profile) => profile.id === input.target.profileId)
              ?.name ?? source.name;
        } catch (cause) {
          // Clear the new target's partition on registration failure so imported cookies cannot outlive its
          // profile.
          await clearBrowserProfileData(bridge, [environmentId], input.target.profileId).catch(
            () => undefined,
          );
          const reason = isProfileLimitReachedError(cause)
            ? "profileLimitReached"
            : "profileNotSaved";
          throw new Error(`Importing cookies from ${source.id} failed: ${reason}.`, { cause });
        }
      } else {
        targetName = source.name;
      }
    } else {
      targetName = input.target.name;
    }
    return {
      kind: "imported",
      imported: result.imported,
      skipped: result.skipped,
      skippedDomains: result.skippedDomains,
      targetName,
    };
  } catch (cause) {
    const policyRefusal = importPolicyRefusal(cause);
    return policyRefusal !== undefined
      ? { kind: "blocked", reason: "readFailed", message: policyRefusal }
      : { kind: "blocked", reason: importFailureReason(cause) };
  }
}

const viewportSelectValue = (viewport: PreviewViewportSetting): string => {
  if (viewport._tag === "fill") return FILL_VALUE;
  if (
    viewport._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === viewport.presetId)
  ) {
    return viewport.presetId;
  }
  return RESPONSIVE_VALUE;
};

/** Inline options lack an items map; bare SelectValue would display the stored fill token. */
const viewportSelectLabel = (
  t: ReturnType<typeof useT>,
  viewport: PreviewViewportSetting,
): string => {
  const value = viewportSelectValue(viewport);
  if (value === FILL_VALUE) return t("settings.code.browser.viewport.fill");
  if (value === RESPONSIVE_VALUE) return t("settings.code.browser.viewport.responsive");
  return (
    PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ??
    t("settings.code.browser.viewport.responsive")
  );
};

const isValidDimension = (value: number) =>
  Number.isInteger(value) &&
  value >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
  value <= PREVIEW_VIEWPORT_MAX_DIMENSION;

const rotateViewport = (
  viewport: Exclude<PreviewViewportSetting, { readonly _tag: "fill" }>,
): PreviewViewportSetting => ({
  ...viewport,
  width: viewport.height,
  height: viewport.width,
});

function BrowserViewportSetting({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const viewport = useClientSettings((settings) => settings.browserDefaultViewport);
  const updateSettings = useUpdatePrimarySettings();

  const sized = viewport._tag === "fill" ? null : viewport;
  const presentedSize = {
    width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
    height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
  };

  const selectViewport = (value: string | null) => {
    if (value === FILL_VALUE) {
      updateSettings({ browserDefaultViewport: FILL_PREVIEW_VIEWPORT });
      return;
    }
    if (value === RESPONSIVE_VALUE) {
      updateSettings({
        browserDefaultViewport: {
          _tag: "freeform",
          width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
          height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
        },
      });
      return;
    }
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) return;
    updateSettings({
      browserDefaultViewport: {
        _tag: "preset",
        width: preset.width,
        height: preset.height,
        presetId: preset.id,
      },
    });
  };

  // Commit on blur to avoid persisting valid intermediate dimensions and rewriting settings per keystroke.
  const commitDimension = (axis: "width" | "height", value: number | null) => {
    if (value === null || !isValidDimension(value)) return;
    const next = { ...presentedSize, [axis]: value };
    if (next.width * next.height > PREVIEW_VIEWPORT_MAX_AREA) return;
    if (sized && next.width === sized.width && next.height === sized.height) return;
    updateSettings({ browserDefaultViewport: { _tag: "freeform", ...next } });
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-default-viewport")}
      title={t("settings.code.browser.viewport.title")}
      description={t("settings.code.browser.viewport.description")}
      resetAction={
        !disabled && viewport._tag !== DEFAULT_BROWSER_VIEWPORT._tag ? (
          <SettingResetButton
            label={t("settings.code.browser.viewport.resetLabel")}
            onClick={() => updateSettings({ browserDefaultViewport: DEFAULT_BROWSER_VIEWPORT })}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Select
            value={viewportSelectValue(viewport)}
            onValueChange={selectViewport}
            disabled={disabled}
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-44"
              aria-label={t("settings.code.browser.viewport.title")}
            >
              <SelectValue>{viewportSelectLabel(t, viewport)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={FILL_VALUE}>{t("settings.code.browser.viewport.fill")}</SelectItem>
              <SelectItem value={RESPONSIVE_VALUE}>
                {t("settings.code.browser.viewport.responsive")}
              </SelectItem>
              <SelectGroup>
                <SelectGroupLabel>{t("settings.code.browser.viewport.standard")}</SelectGroupLabel>
                {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    <span className="flex w-full items-center justify-between gap-5">
                      <span>{preset.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {preset.detail}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>

          {sized ? (
            <div className="flex min-w-0 items-center gap-1">
              <NumberField
                value={presentedSize.width}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("width", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label={t("settings.code.browser.viewport.width")} />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">×</span>
              <NumberField
                value={presentedSize.height}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("height", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label={t("settings.code.browser.viewport.height")} />
                </NumberFieldGroup>
              </NumberField>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={disabled}
                      aria-label={
                        presentedSize.height >= presentedSize.width
                          ? t("settings.code.browser.viewport.rotateLandscape")
                          : t("settings.code.browser.viewport.rotatePortrait")
                      }
                      onClick={() =>
                        updateSettings({ browserDefaultViewport: rotateViewport(sized) })
                      }
                    >
                      <ScreenRotationIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">{t("settings.code.browser.viewport.rotate")}</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function BrowserZoomSetting({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const zoomFactor = useClientSettings((settings) => settings.browserDefaultZoomFactor);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-zoom")}
      title={t("settings.code.browser.zoom.title")}
      description={t("settings.code.browser.zoom.description")}
      resetAction={
        !disabled && zoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
          <SettingResetButton
            label={t("settings.code.browser.zoom.resetLabel")}
            onClick={() =>
              updateSettings({ browserDefaultZoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={String(zoomFactor)}
          onValueChange={(value) => {
            const next = PREVIEW_ZOOM_LEVELS.find((level) => String(level) === value);
            if (next !== undefined) updateSettings({ browserDefaultZoomFactor: next });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("settings.code.browser.zoom.title")}
          >
            <SelectValue>{zoomLabel(zoomFactor)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {PREVIEW_ZOOM_LEVELS.map((level) => (
              <SelectItem hideIndicator key={level} value={String(level)}>
                {zoomLabel(level)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserAppearanceSetting({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const appearance = useClientSettings((settings) => settings.browserDefaultAppearance);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-appearance")}
      title={t("settings.code.browser.appearance.title")}
      description={t("settings.code.browser.appearance.description")}
      resetAction={
        !disabled && appearance !== DEFAULT_PREVIEW_APPEARANCE ? (
          <SettingResetButton
            label={t("settings.code.browser.appearance.resetLabel")}
            onClick={() => updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={appearance}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") {
              updateSettings({ browserDefaultAppearance: value });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("settings.code.browser.appearance.title")}
          >
            <SelectValue>{t(APPEARANCE_LABELS[appearance])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(APPEARANCE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserRecordingInputSettings({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const showKeys = useClientSettings((settings) => settings.browserRecordingShowKeyPresses);
  const showMouse = useClientSettings((settings) => settings.browserRecordingShowMousePresses);
  const updateSettings = useUpdatePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("browser-recording-key-presses")}
        title={t("settings.code.browser.recording.keys.title")}
        description={t("settings.code.browser.recording.keys.description")}
        control={
          <Switch
            disabled={disabled}
            checked={showKeys}
            aria-label={t("settings.code.browser.recording.keys.title")}
            onCheckedChange={(checked) =>
              updateSettings({ browserRecordingShowKeyPresses: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("browser-recording-mouse-presses")}
        title={t("settings.code.browser.recording.mouse.title")}
        description={t("settings.code.browser.recording.mouse.description")}
        control={
          <Switch
            disabled={disabled}
            checked={showMouse}
            aria-label={t("settings.code.browser.recording.mouse.title")}
            onCheckedChange={(checked) =>
              updateSettings({ browserRecordingShowMousePresses: Boolean(checked) })
            }
          />
        }
      />
    </>
  );
}

function BrowserRecordingFrameRateSetting({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const frameRate = useClientSettings((settings) => settings.browserRecordingFrameRate);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-recording-frame-rate")}
      title={t("settings.code.browser.recording.frameRate.title")}
      description={t("settings.code.browser.recording.frameRate.description")}
      resetAction={
        !disabled && frameRate !== DEFAULT_BROWSER_RECORDING_FRAME_RATE ? (
          <SettingResetButton
            label={t("settings.code.browser.recording.frameRate.resetLabel")}
            onClick={() =>
              updateSettings({ browserRecordingFrameRate: DEFAULT_BROWSER_RECORDING_FRAME_RATE })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={String(frameRate)}
          onValueChange={(value) => {
            const next = BROWSER_RECORDING_FRAME_RATES.find((rate) => String(rate) === value);
            if (next !== undefined) {
              updateSettings({ browserRecordingFrameRate: next });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("settings.code.browser.recording.frameRate.title")}
          >
            <SelectValue>
              {t("settings.code.browser.recording.frameRate.fps", { rate: frameRate })}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {BROWSER_RECORDING_FRAME_RATES.map((rate) => (
              <SelectItem hideIndicator key={rate} value={String(rate)}>
                {t("settings.code.browser.recording.frameRate.fps", { rate })}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const LINK_TARGET_LABELS: Readonly<Record<BrowserLinkTarget, MessageKey>> = {
  system: "settings.code.browser.linkTarget.system",
  app: "settings.code.browser.linkTarget.app",
};

function BrowserLinkTargetSetting({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const linkTarget = useClientSettings((settings) => settings.browserLinkTarget);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-link-target")}
      title={t("settings.code.browser.linkTarget.title")}
      description={t("settings.code.browser.linkTarget.description")}
      resetAction={
        !disabled && linkTarget !== DEFAULT_BROWSER_LINK_TARGET ? (
          <SettingResetButton
            label={t("settings.code.browser.linkTarget.resetLabel")}
            onClick={() => updateSettings({ browserLinkTarget: DEFAULT_BROWSER_LINK_TARGET })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={linkTarget}
          onValueChange={(value) => {
            if (value === "system" || value === "app") {
              updateSettings({ browserLinkTarget: value });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("settings.code.browser.linkTarget.title")}
          >
            <SelectValue>{t(LINK_TARGET_LABELS[linkTarget])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(Object.keys(LINK_TARGET_LABELS) as ReadonlyArray<BrowserLinkTarget>).map((target) => (
              <SelectItem hideIndicator key={target} value={target}>
                {t(LINK_TARGET_LABELS[target])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const SEARCH_ENGINE_LABELS: Readonly<Record<BrowserSearchEngine, string | MessageKey>> = {
  duckduckgo: "DuckDuckGo",
  google: "Google",
  bing: "Bing",
  brave: "Brave Search",
  kagi: "Kagi",
  ecosia: "Ecosia",
  custom: "settings.code.browser.searchEngine.custom",
};

function BrowserSearchEngineSetting() {
  const t = useT();
  const engineLabel = (literal: BrowserSearchEngine) =>
    literal === "custom"
      ? t("settings.code.browser.searchEngine.custom")
      : SEARCH_ENGINE_LABELS[literal];
  const engine = useClientSettings((settings) => settings.browserSearchEngine);
  const customUrl = useClientSettings((settings) => settings.browserCustomSearchUrl);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <>
      <SettingsRow
        {...searchableSetting("browser-search-engine")}
        title={t("settings.code.browser.searchEngine.title")}
        description={t("settings.code.browser.searchEngine.description")}
        resetAction={
          engine !== DEFAULT_BROWSER_SEARCH_ENGINE || customUrl !== "" ? (
            <SettingResetButton
              label={t("settings.code.browser.searchEngine.resetLabel")}
              onClick={() =>
                updateSettings({
                  browserSearchEngine: DEFAULT_BROWSER_SEARCH_ENGINE,
                  browserCustomSearchUrl: "",
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={engine}
            onValueChange={(value) => {
              const next = BrowserSearchEngine.literals.find((literal) => literal === value);
              if (next !== undefined) {
                updateSettings({ browserSearchEngine: next });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label={t("settings.code.browser.searchEngine.title")}
            >
              <SelectValue>{engineLabel(engine)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BrowserSearchEngine.literals.map((literal) => (
                <SelectItem hideIndicator key={literal} value={literal}>
                  {engineLabel(literal)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {engine === "custom" ? (
        <SettingsRow
          title={t("settings.code.browser.searchEngine.customUrl.title")}
          description={t("settings.code.browser.searchEngine.customUrl.description")}
          status={
            isValidSearchUrlTemplate(customUrl)
              ? undefined
              : t("settings.code.browser.searchEngine.customUrl.invalid")
          }
          control={
            <DraftInput
              nativeInput
              size="sm"
              className="w-full sm:w-64"
              aria-label={t("settings.code.browser.searchEngine.customUrl.title")}
              placeholder="https://example.com/search?q=%s"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH}
              value={customUrl}
              onCommit={(next) => updateSettings({ browserCustomSearchUrl: next.trim() })}
            />
          }
        />
      ) : null}
    </>
  );
}

export function PullRequestLinksOpenInAppSetting() {
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  const updateSettings = useUpdatePrimarySettings();
  const t = useT();

  return (
    <SettingsRow
      {...searchableSetting("pull-request-links-open-in-app")}
      title={t("settings.diffs.prLinksInApp.title")}
      description={t("settings.diffs.prLinksInApp.description")}
      resetAction={
        openInApp ? null : (
          <SettingResetButton
            label={t("settings.diffs.prLinksInApp.resetLabel")}
            onClick={() => updateSettings({ pullRequestLinksOpenInApp: true })}
          />
        )
      }
      control={
        <Switch
          checked={openInApp}
          onCheckedChange={(checked) =>
            updateSettings({ pullRequestLinksOpenInApp: Boolean(checked) })
          }
          aria-label={t("settings.diffs.prLinksInApp.a11y")}
        />
      }
    />
  );
}

function DeviceIntegrationSettings() {
  const t = useT();
  const { search, environment: selected } = useSettingsScope();
  const settings = useScopedSettings();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;
  const environmentId = connected ? selected.environmentId : null;

  const { state } = useDeviceState(environmentId);

  return (
    <>
      <SettingsSection id="devices" title={t("settings.code.devices.title")}>
        <DeviceIntegrationControls
          key={`${environmentId}:${JSON.stringify(search)}`}
          environmentId={environmentId}
          enabled={settings.enableDeviceSupport}
          agentAccessEnabled={settings.enableAgentDeviceAccess}
        />
      </SettingsSection>
      <DeviceSourcesSettings
        supportsEas={state.supportsEasHosts === true}
        supportsSimlock={state.supportsSimlockHosts === true}
      />
    </>
  );
}

function DeviceIntegrationControls({
  environmentId,
  enabled,
  agentAccessEnabled,
}: {
  environmentId: EnvironmentId | null;
  enabled: boolean;
  agentAccessEnabled: boolean;
}) {
  const t = useT();
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { state, loaded } = useDeviceState(environmentId);
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const anyHubEnabled = connectedEnvironments.some(
    (environment) => environment.serverConfig?.settings.enableDeviceSupport,
  );
  const configure = useAtomCommand(deviceEnvironment.configure, { reportFailure: false });
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const [pending, setPending] = useState<
    "hub" | "check" | "agent" | "update-hub" | "update-agent" | null
  >(null);
  const { busy } = deviceHubReadiness(state);

  const update = async (
    kind: NonNullable<typeof pending>,
    input: { enabled?: boolean; agentAccessEnabled?: boolean },
  ) => {
    if (!environmentId || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    setPending(kind);
    const results = await Promise.allSettled(
      environments.map(async (environment) => {
        if (environment.connection.phase !== "connected" || !environment.serverConfig) {
          throw new Error("Environment disconnected");
        }
        if (!readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)) {
          throw new Error("This connection cannot change device settings.");
        }
        return configure({
          environmentId: environment.environmentId,
          input: { ...input, ...(input.enabled ? { onboardingCompleted: true } : {}) },
        });
      }),
    );
    setPending(null);
    const failed = environments.filter((_, index) => {
      const result = results[index];
      return result?.status !== "fulfilled" || result.value._tag === "Failure";
    });
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title: t("settings.code.devices.notSaved"),
        description: t("settings.code.devices.couldNotUpdate", {
          names: failed.map((environment) => environment.label).join(", "),
        }),
      });
    }
  };

  const [updateError, setUpdateError] = useState<{ tool: "hub" | "agent"; message: string } | null>(
    null,
  );
  const localTools = state.hosts.find((host) => host.kind === "local")?.tools;
  const versionActions = (tool: "hub" | "agent") => {
    const version = localTools?.[tool];
    const needsUpdate = version && !version.installedVersions.includes(version.requiredVersion);
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {state.supportsToolUpdate && needsUpdate ? (
            <Button
              size="sm"
              disabled={!environmentId || pending !== null || busy}
              onClick={() => {
                if (!environmentId) return;
                setUpdateError(null);
                setPending(`update-${tool}`);
                void list({ environmentId, input: { updateTool: tool } })
                  .then((result) => {
                    if (result._tag === "Failure")
                      setUpdateError({ tool, message: formatEnvironmentQueryError(result.cause) });
                  })
                  .finally(() => setPending(null));
              }}
            >
              {pending === `update-${tool}`
                ? t("settings.code.devices.updating")
                : t("settings.code.devices.update")}
            </Button>
          ) : null}
          {state.supportsToolInspection ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!environmentId || pending !== null || busy}
              onClick={() => {
                if (!environmentId) return;
                setPending("check");
                void list({ environmentId, input: { inspectOnly: true } }).finally(() =>
                  setPending(null),
                );
              }}
            >
              {pending === "check"
                ? t("settings.code.devices.checking")
                : t("settings.code.devices.checkVersions")}
            </Button>
          ) : null}
        </div>
        {updateError?.tool === tool ? (
          <p role="alert" className="text-xs text-destructive">
            {updateError.message}
          </p>
        ) : null}
      </div>
    );
  };

  const [hubBefore, hubAfter] = t("settings.code.devices.hub.description", {
    versions: SLOT,
  }).split(SLOT);
  const [agentBefore, agentAfter] = t("settings.code.devices.agent.description", {
    versions: SLOT,
  }).split(SLOT);

  return (
    <>
      <SettingsRow
        {...searchableSetting("device-hub")}
        serverScoped
        settingKeys={["enableDeviceSupport"]}
        title={t("settings.code.devices.hub.title")}
        description={
          <>
            {hubBefore}
            <DeviceToolVersions
              action={versionActions("hub")}
              kind="hub"
              tools={state.hosts.find((host) => host.kind === "local")?.tools}
            />
            {hubAfter}
          </>
        }
        control={
          <>
            {pending === "hub" ? <DeviceHubSetupStatus state={state} pending compact /> : null}
            <ScopedSwitch
              settingKeys={["enableDeviceSupport"]}
              checked={enabled}
              disabled={
                !canConfigure ||
                projectScope ||
                !loaded ||
                !environmentId ||
                busy ||
                pending !== null
              }
              aria-label={t("settings.code.devices.hub.a11y")}
              onCheckedChange={(checked) =>
                void update("hub", {
                  enabled: Boolean(checked),
                  ...(checked ? {} : { agentAccessEnabled: false }),
                })
              }
            />
          </>
        }
      />
      <SettingsRow
        {...searchableSetting("agent-device-access")}
        serverScoped
        settingKeys={["enableAgentDeviceAccess"]}
        title={t("settings.code.devices.agent.title")}
        description={
          <>
            {agentBefore}
            <DeviceToolVersions
              action={versionActions("agent")}
              kind="agent"
              tools={state.hosts.find((host) => host.kind === "local")?.tools}
            />
            {agentAfter}
          </>
        }
        control={
          <>
            {pending === "agent" ? <AgentDeviceSetupStatus state={state} pending compact /> : null}
            <ScopedSwitch
              settingKeys={["enableAgentDeviceAccess"]}
              checked={agentAccessEnabled}
              disabled={
                !canConfigure ||
                connectedEnvironments.length === 0 ||
                (!projectScope && (!loaded || !anyHubEnabled || busy)) ||
                pending !== null
              }
              aria-label={t("settings.code.devices.agent.a11y")}
              onCheckedChange={(checked) =>
                projectScope
                  ? updateSettings({ enableAgentDeviceAccess: Boolean(checked) })
                  : void update("agent", { agentAccessEnabled: Boolean(checked) })
              }
            />
          </>
        }
      />
      {environmentId ? (
        <DeviceHostUpdates
          state={{ ...state, hosts: state.hosts.filter((host) => host.kind === "local") }}
          environmentId={environmentId}
        />
      ) : null}
    </>
  );
}

function AgentBrowserAccessSetting() {
  const t = useT();
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableAgentBrowserAccess"]}
      {...searchableSetting("agent-browser-access")}
      title={t("settings.code.browser.agentAccess.title")}
      description={
        isProjectScope
          ? t("settings.code.browser.agentAccess.descriptionProject")
          : t("settings.code.browser.agentAccess.description")
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label={t("settings.code.browser.agentAccess.resetLabel")}
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentBrowserAccess"]}
          aria-label={t("settings.code.browser.agentAccess.title")}
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
        />
      }
    />
  );
}

function BrowserAutoShowFloatingPreviewSetting({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const autoShow = useClientSettings((settings) => settings.browserAutoShowFloatingPreview);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-auto-show-floating-preview")}
      title={t("settings.code.browser.autoShow.title")}
      description={t("settings.code.browser.autoShow.description")}
      resetAction={
        !disabled && autoShow !== DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW ? (
          <SettingResetButton
            label={t("settings.code.browser.autoShow.resetLabel")}
            onClick={() =>
              updateSettings({
                browserAutoShowFloatingPreview: DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          disabled={disabled}
          checked={autoShow}
          onCheckedChange={(checked) =>
            updateSettings({ browserAutoShowFloatingPreview: Boolean(checked) })
          }
          aria-label={t("settings.code.browser.autoShow.title")}
        />
      }
    />
  );
}

function BrowserProfilesSetting({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const defaultProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  // Cookie import runs on this desktop, whose policy the primary environment reports.
  const cookieImportDenial = managedCapabilityDenial(
    usePrimaryManagedPolicy(),
    "browserCookieImport",
  );
  const [sources, setSources] = useState<ReadonlyArray<BrowserImportSource> | null>(null);
  const [importSession, setImportSession] = useState<{
    readonly source: BrowserImportSource;
    readonly environmentId: EnvironmentId;
    readonly environmentName: string;
  } | null>(null);
  const [profilePendingRemoval, setProfilePendingRemoval] = useState<BrowserProfile | null>(null);
  const [profilePendingClear, setProfilePendingClear] = useState<BrowserProfile | null>(null);
  const [profileRemovalError, setProfileRemovalError] = useState<string | null>(null);
  const [profileRemovalInFlight, setProfileRemovalInFlight] = useState(false);
  const serverConfigs = useServerConfigs();
  const runClearServerProfile = useAtomCommand(previewEnvironment.clearProfile, {
    reportFailure: false,
  });
  const serverProfileData: ServerProfileData = {
    environmentIds: environments
      .map((environment) => environment.environmentId)
      .filter(
        (environmentId) =>
          serverConfigs.get(environmentId)?.environment.capabilities.serverBrowser === true,
      ),
    clear: async (environmentId, profileId) => {
      const result = await runClearServerProfile({ environmentId, input: { profileId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
  };
  const removalAvailable = browserProfileRemovalAvailable(
    previewBridge !== null,
    environmentsReady,
    environments.length,
    serverProfileData.environmentIds.length,
  );
  const importInFlightRef = useRef(false);
  const [importInFlight, setImportInFlight] = useState(false);
  const profileWritesDisabled = disabled || !settingsHydrated;

  const profiles = resolveBrowserProfiles(userProfiles);
  const listedProfiles = profiles.filter((profile) => profile.kind !== "incognito");
  const resolvedDefaultId =
    findBrowserProfile(listedProfiles, defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID;

  const createProfile = (baseName: string) => {
    if (!settingsHydrated || importInFlightRef.current) return undefined;
    const currentProfiles = getClientSettings().browserProfiles;
    // Check live settings; repeated clicks before render can bypass the disabled control.
    if (currentProfiles.length >= BROWSER_PROFILE_MAX_COUNT) return undefined;
    const resolvedProfiles = resolveBrowserProfiles(currentProfiles);
    const taken = new Set(resolvedProfiles.map((profile) => profile.name));
    let name = baseName;
    for (let index = 2; taken.has(name); index += 1) name = `${baseName} ${index}`;
    const profile = { id: `profile-${randomUUID()}`, name, kind: "persistent" as const };
    updateSettings({ browserProfiles: [...currentProfiles, profile] });
    return profile;
  };

  const renameProfile = (id: string, next: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    const name = next.trim().slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH);
    if (name === "") return;
    const currentProfiles = getClientSettings().browserProfiles;
    updateSettings({
      browserProfiles: currentProfiles.map((profile) =>
        profile.id === id ? { ...profile, name } : profile,
      ),
    });
  };

  const clearProfileData = (id: string, name: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    if (!removalAvailable) {
      toastManager.add({
        type: "error",
        title: t("settings.code.browser.profiles.clearFailed", { name }),
        description: t("settings.code.browser.profiles.notConnected"),
      });
      return;
    }
    void clearBrowserProfileData(
      previewBridge,
      environments.map((environment) => environment.environmentId),
      id,
      serverProfileData,
    )
      .then(() => {
        toastManager.add({
          type: "success",
          title: t("settings.code.browser.profiles.cleared", { name }),
        });
      })
      .catch(() => {
        toastManager.add({
          type: "error",
          title: t("settings.code.browser.profiles.clearFailed", { name }),
        });
      });
  };

  const removeProfile = async (id: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    if (!removalAvailable) {
      setProfileRemovalError(t("settings.code.browser.profiles.connectBeforeRemoving"));
      return;
    }
    setProfileRemovalError(null);
    setProfileRemovalInFlight(true);
    try {
      await clearBrowserProfileData(
        previewBridge,
        environmentsReady ? environments.map((environment) => environment.environmentId) : [],
        id,
        serverProfileData,
      );
    } catch {
      setProfileRemovalError(t("settings.code.browser.profiles.deleteFailed"));
      setProfileRemovalInFlight(false);
      return;
    }
    const currentSettings = getClientSettings();
    updateSettings({
      browserProfiles: currentSettings.browserProfiles.filter((profile) => profile.id !== id),
      ...(currentSettings.browserDefaultProfileId === id
        ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
        : {}),
    });
    setProfileRemovalInFlight(false);
    setProfilePendingRemoval(null);
  };

  const importableSources = (sources ?? []).filter(
    (source) =>
      source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform",
  );

  const loadSources = () => {
    if (!previewBridge) return;
    void previewBridge
      .listBrowserImportSources()
      .then(setSources)
      .catch(() => setSources((previous) => previous ?? []));
  };

  const runWizardImport = async (
    source: BrowserImportSource,
    environmentId: EnvironmentId,
    input: { readonly sourceProfileDirectory: string; readonly target: WizardTarget },
  ): Promise<ImportOutcome> => {
    if (!previewBridge) return { kind: "blocked", reason: "sessionUnavailable" };
    if (!settingsHydrated) return { kind: "blocked", reason: "sessionUnavailable" };
    if (
      input.target.kind === "existing" &&
      !resolveBrowserProfiles(getClientSettings().browserProfiles).some(
        (profile) => profile.id === input.target.profileId,
      )
    ) {
      return { kind: "blocked", reason: "readFailed" };
    }
    if (importInFlightRef.current) return { kind: "blocked", reason: "readFailed" };
    importInFlightRef.current = true;
    setImportInFlight(true);
    return importBrowserCookiesIntoTarget(previewBridge, source, environmentId, input).finally(
      () => {
        importInFlightRef.current = false;
        setImportInFlight(false);
      },
    );
  };

  const refreshImportSource = async (
    sourceId: BrowserImportSource["id"],
  ): Promise<BrowserImportSource | undefined> => {
    if (!previewBridge) return undefined;
    try {
      const latest = await previewBridge.listBrowserImportSources();
      setSources(latest);
      return latest.find((source) => source.id === sourceId);
    } catch {
      return undefined;
    }
  };

  const atProfileLimit = userProfiles.length >= BROWSER_PROFILE_MAX_COUNT;

  return (
    <SettingsRow
      {...searchableSetting("browser-profiles")}
      title={t("settings.code.browser.profiles.title")}
      description={t("settings.code.browser.profiles.description")}
      control={
        <Menu onOpenChange={(open) => open && loadSources()}>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                disabled={profileWritesDisabled || importInFlight}
              />
            }
          >
            <PlusIcon />
            {t("settings.code.browser.profiles.add")}
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={!settingsHydrated || atProfileLimit}
              onClick={() => createProfile("New profile")}
            >
              {t("settings.code.browser.profiles.blank")}
            </MenuItem>
            {atProfileLimit ? (
              <MenuItem disabled>{t("settings.code.browser.profiles.limit")}</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{t("settings.code.browser.profiles.importFrom")}</MenuGroupLabel>
              {cookieImportDenial !== undefined ? (
                <MenuItem disabled>{cookieImportDenial}</MenuItem>
              ) : sources === null ? (
                <MenuItem disabled>
                  {t("settings.code.browser.profiles.lookingForBrowsers")}
                </MenuItem>
              ) : importableSources.length === 0 ? (
                <MenuItem disabled>{t("settings.code.browser.profiles.noBrowsers")}</MenuItem>
              ) : (
                <>
                  {importableSources.map((source) => (
                    <MenuItem
                      key={source.id}
                      disabled={!settingsHydrated || primaryEnvironment == null}
                      onClick={() => {
                        if (!settingsHydrated || primaryEnvironment == null) return;
                        setImportSession({
                          source,
                          environmentId: primaryEnvironment.environmentId,
                          environmentName: resolveEnvironmentOptionLabel({
                            isPrimary: true,
                            environmentId: primaryEnvironment.environmentId,
                            runtimeLabel: primaryEnvironment.label,
                          }),
                        });
                      }}
                    >
                      {source.name}
                    </MenuItem>
                  ))}
                  {primaryEnvironment == null ? (
                    <MenuItem disabled>
                      {t("settings.code.browser.profiles.connectToImport")}
                    </MenuItem>
                  ) : null}
                </>
              )}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      }
    >
      <div className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60">
        {listedProfiles.map((profile, index) => {
          const builtIn = isBuiltInBrowserProfileId(profile.id);
          const isDefault = profile.id === resolvedDefaultId;
          return (
            <div
              key={profile.id}
              className={cn(
                "flex items-center gap-3 px-3 py-2",
                index > 0 && "border-t border-border/60",
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {builtIn ? (
                  <span
                    className={cn(
                      "truncate text-sm text-foreground",
                      profileWritesDisabled && "opacity-64",
                    )}
                  >
                    {profile.name}
                  </span>
                ) : (
                  <DraftInput
                    nativeInput
                    size="sm"
                    className="w-full max-w-56"
                    aria-label={t("settings.code.browser.profiles.rename", { name: profile.name })}
                    disabled={profileWritesDisabled || importInFlight}
                    maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH}
                    value={profile.name}
                    onCommit={(next) => renameProfile(profile.id, next)}
                  />
                )}
                {isDefault ? (
                  <span className={cn("flex", profileWritesDisabled && "opacity-64")}>
                    <Badge>{t("settings.code.browser.profiles.default")}</Badge>
                  </span>
                ) : null}
              </span>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      disabled={profileWritesDisabled || importInFlight}
                      aria-label={t("settings.code.browser.profiles.options", {
                        name: profile.name,
                      })}
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={!settingsHydrated || isDefault}
                    onClick={() => {
                      if (settingsHydrated) {
                        updateSettings({ browserDefaultProfileId: profile.id });
                      }
                    }}
                  >
                    {t("settings.code.browser.profiles.setDefault")}
                  </MenuItem>
                  <MenuItem
                    disabled={!settingsHydrated || !removalAvailable}
                    onClick={() => {
                      if (serverProfileData.environmentIds.length > 0) {
                        setProfilePendingClear(profile);
                      } else clearProfileData(profile.id, profile.name);
                    }}
                  >
                    {t("settings.code.browser.profiles.clearCookies")}
                  </MenuItem>
                  {builtIn ? null : (
                    <MenuItem
                      variant="destructive"
                      disabled={!settingsHydrated || !removalAvailable}
                      onClick={() => {
                        if (settingsHydrated) setProfilePendingRemoval(profile);
                      }}
                    >
                      {t("settings.code.browser.profiles.removeWithData")}
                    </MenuItem>
                  )}
                  {!removalAvailable ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled>
                        {environmentsReady
                          ? t("settings.code.browser.profiles.connectToClear")
                          : t("settings.code.browser.profiles.checkingEnvironments")}
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
          );
        })}
      </div>
      <AlertDialog
        open={profilePendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !profileRemovalInFlight) {
            setProfilePendingRemoval(null);
            setProfileRemovalError(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.code.browser.profiles.removeTitle", {
                name: profilePendingRemoval?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.code.browser.profiles.removeDescription")}
            </AlertDialogDescription>
            {profileRemovalError ? (
              <p aria-live="polite" className="text-sm text-destructive">
                {profileRemovalError}
              </p>
            ) : null}
            {!removalAvailable ? (
              <p className="text-sm text-muted-foreground">
                {t("settings.code.browser.profiles.connectToRemove")}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={profileRemovalInFlight}
              render={<Button variant="outline" disabled={profileRemovalInFlight} />}
            >
              {t("settings.code.browser.profiles.cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={profileRemovalInFlight || !settingsHydrated || !removalAvailable}
              onClick={() => {
                if (profilePendingRemoval && settingsHydrated && removalAvailable) {
                  void removeProfile(profilePendingRemoval.id);
                }
              }}
            >
              {profileRemovalInFlight
                ? t("settings.code.browser.profiles.removing")
                : t("settings.code.browser.profiles.removeProfile")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={profilePendingClear !== null}
        onOpenChange={(open) => {
          if (!open) setProfilePendingClear(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.code.browser.profiles.clearTitle", {
                name: profilePendingClear?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.code.browser.profiles.clearDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("settings.code.browser.profiles.cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (profilePendingClear)
                  clearProfileData(profilePendingClear.id, profilePendingClear.name);
                setProfilePendingClear(null);
              }}
            >
              {t("settings.code.browser.profiles.clearData")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {importSession ? (
        <BrowserImportWizard
          source={importSession.source}
          destinationEnvironmentName={importSession.environmentName}
          targetProfiles={listedProfiles.map((profile) => ({ id: profile.id, name: profile.name }))}
          canCreateProfile={settingsHydrated && !atProfileLimit}
          onImport={(input) =>
            runWizardImport(importSession.source, importSession.environmentId, input)
          }
          onRefreshSource={() => refreshImportSource(importSession.source.id)}
          onCheckFullDiskAccess={
            window.desktopBridge
              ? () => window.desktopBridge!.checkSystemPermission("full-disk-access")
              : undefined
          }
          onOpenFullDiskAccessSettings={async () => {
            await readLocalApi()
              ?.shell.openSystemSettings("full-disk-access")
              .catch(() => {
                toastManager.add({
                  type: "error",
                  title: t("settings.code.browser.profiles.openSettingsFailed"),
                  description: t("settings.code.browser.profiles.openSettingsHint"),
                });
              });
          }}
          onClose={() => setImportSession(null)}
        />
      ) : null}
    </SettingsRow>
  );
}

export function BrowserSettingsPanel() {
  const t = useT();
  const desktopOnly = !isElectron;
  const desktopOnlyMessage = desktopOnly ? t("settings.code.browser.desktopOnly") : undefined;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="browser-agent-access"
        title={t("settings.code.browser.sectionAgentAccess")}
      >
        <AgentBrowserAccessSetting />
      </SettingsSection>
      <SettingsSection id="browser" title={t("settings.code.browser.sectionBrowsing")}>
        <SettingsUnavailableGroup message={desktopOnlyMessage}>
          <BrowserProfilesSetting disabled={desktopOnly} />
          <BrowserLinkTargetSetting disabled={desktopOnly} />
          <BrowserAutoShowFloatingPreviewSetting disabled={desktopOnly} />
        </SettingsUnavailableGroup>
        {/* Not desktop-only: web clients search from server-run browser tabs too. */}
        <BrowserSearchEngineSetting />
        <AdvancedSettings
          targetIds={[
            searchableSetting("browser-default-viewport").id,
            searchableSetting("browser-default-zoom").id,
            searchableSetting("browser-default-appearance").id,
          ]}
        >
          <SettingsUnavailableGroup message={desktopOnlyMessage}>
            <BrowserViewportSetting disabled={desktopOnly} />
            <BrowserZoomSetting disabled={desktopOnly} />
            <BrowserAppearanceSetting disabled={desktopOnly} />
          </SettingsUnavailableGroup>
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="browser-recordings" title={t("settings.code.browser.sectionRecordings")}>
        <SettingsUnavailableGroup message={desktopOnlyMessage}>
          <BrowserRecordingFrameRateSetting disabled={desktopOnly} />
          <BrowserRecordingInputSettings disabled={desktopOnly} />
        </SettingsUnavailableGroup>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function DevicesSettingsPanel() {
  return (
    <SettingsPageContainer>
      <DeviceIntegrationSettings />
    </SettingsPageContainer>
  );
}
