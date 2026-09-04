/**
 * Integrations settings - preferences for surfaces T3 Code embeds rather than
 * owns. Browser is the first section: the defaults a preview tab opens at,
 * applied to both hand-opened tabs and agent `preview_open` calls that don't
 * state their own size.
 *
 * @module IntegrationsSettings
 */
import {
  BROWSER_PROFILE_MAX_COUNT,
  type BrowserLinkTarget,
  type BrowserProfile,
  type EnvironmentId,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  BROWSER_RECORDING_FRAME_RATES,
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_LINK_TARGET,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  DEFAULT_BROWSER_VIEWPORT,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_ZOOM_LEVELS,
  findBrowserProfile,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import { InfoIcon, Plus as PlusIcon, Trash2 as Trash2Icon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ScreenRotationIcon } from "~/browser/ScreenRotationIcon";
import { previewBridge } from "~/components/preview/previewBridge";
import { cn, randomUUID } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { isElectron } from "../../env";

import { Badge } from "../ui/badge";
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
  useClientSettings,
  useClientSettingsHydrated,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { searchableSetting } from "./settingsSearch";

const FILL_VALUE = "fill";
const RESPONSIVE_VALUE = "responsive";

type BrowserProfileDataBridge = Pick<
  NonNullable<typeof previewBridge>,
  "clearCookies" | "clearCache"
>;

export async function clearBrowserProfileData(
  bridge: BrowserProfileDataBridge | null,
  environmentIds: ReadonlyArray<EnvironmentId>,
  profileId: string,
): Promise<void> {
  if (bridge === null || environmentIds.length === 0) {
    throw new Error("Browser profile data is not available to clear.");
  }
  await Promise.all(
    environmentIds.flatMap((environmentId) => [
      bridge.clearCookies(environmentId, profileId),
      bridge.clearCache(environmentId, profileId),
    ]),
  );
}

export function browserProfileRemovalAvailable(
  bridgeAvailable: boolean,
  environmentsReady: boolean,
  environmentCount: number,
): boolean {
  return bridgeAvailable && environmentsReady && environmentCount > 0;
}

/**
 * The size a "Responsive" default falls back to when the user switches away
 * from Fill and hasn't typed dimensions yet. Fill has no dimensions to carry
 * over, so the picker needs something concrete to seed the inputs with.
 */
const RESPONSIVE_SEED_SIZE = { width: 1280, height: 800 } as const;

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

const APPEARANCE_LABELS: Readonly<Record<PreviewAppearancePreference, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const zoomLabel = (zoomFactor: number) => `${Math.round(zoomFactor * 100)}%`;

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

/**
 * The trigger renders this rather than a bare `SelectValue`, which would fall
 * back to printing the raw stored value ("fill") because the options are built
 * inline instead of from an `items` map.
 */
const viewportSelectLabel = (viewport: PreviewViewportSetting): string => {
  const value = viewportSelectValue(viewport);
  if (value === FILL_VALUE) return "Fill panel";
  if (value === RESPONSIVE_VALUE) return "Responsive";
  return PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ?? "Responsive";
};

const isValidDimension = (value: number) =>
  Number.isInteger(value) &&
  value >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
  value <= PREVIEW_VIEWPORT_MAX_DIMENSION;

/**
 * A sized viewport with width and height swapped. Presets keep their identity
 * through a rotation — `resolvePreviewViewport` already stores rotated presets
 * as the preset id plus swapped dimensions — so a rotated iPad is still an
 * iPad, not an anonymous custom size.
 */
const rotateViewport = (
  viewport: Exclude<PreviewViewportSetting, { readonly _tag: "fill" }>,
): PreviewViewportSetting => ({
  ...viewport,
  width: viewport.height,
  height: viewport.width,
});

function BrowserViewportSetting({ disabled }: { readonly disabled: boolean }) {
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

  // Committed on blur rather than per keystroke: typing "2560" passes through
  // "256", which is a legal dimension, so an onValueChange handler would
  // persist that intermediate size and churn the settings file on every key.
  const commitDimension = (axis: "width" | "height", value: number | null) => {
    if (value === null || !isValidDimension(value)) return;
    const next = { ...presentedSize, [axis]: value };
    if (next.width * next.height > PREVIEW_VIEWPORT_MAX_AREA) return;
    if (sized && next.width === sized.width && next.height === sized.height) return;
    // Typing a size means the preset no longer describes it.
    updateSettings({ browserDefaultViewport: { _tag: "freeform", ...next } });
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-default-viewport")}
      description="The viewport a browser tab opens at, for both you and agents. Fill sizes the page to the panel; any other choice opens the device toolbar at that size."
      resetAction={
        !disabled && viewport._tag !== DEFAULT_BROWSER_VIEWPORT._tag ? (
          <SettingResetButton
            label="default browser viewport"
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
              aria-label="Default browser viewport"
            >
              <SelectValue>{viewportSelectLabel(viewport)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-64">
              <SelectItem value={FILL_VALUE}>Fill panel</SelectItem>
              <SelectItem value={RESPONSIVE_VALUE}>Responsive</SelectItem>
              <SelectGroup>
                <SelectGroupLabel>Standard</SelectGroupLabel>
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
                // Pixel counts read as raw numbers; grouping would show "1,024".
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("width", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport width" />
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
                  <NumberFieldInput aria-label="Default viewport height" />
                </NumberFieldGroup>
              </NumberField>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={disabled}
                      aria-label={`Rotate to ${
                        presentedSize.height >= presentedSize.width ? "landscape" : "portrait"
                      }`}
                      onClick={() =>
                        updateSettings({ browserDefaultViewport: rotateViewport(sized) })
                      }
                    >
                      <ScreenRotationIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Rotate</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function BrowserZoomSetting({ disabled }: { readonly disabled: boolean }) {
  const zoomFactor = useClientSettings((settings) => settings.browserDefaultZoomFactor);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-zoom")}
      description="Page zoom applied to new browser tabs."
      resetAction={
        !disabled && zoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
          <SettingResetButton
            label="default browser zoom"
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
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Default browser zoom">
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
  const appearance = useClientSettings((settings) => settings.browserDefaultAppearance);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-appearance")}
      description="The color scheme pages are told to prefer. System follows your OS setting."
      resetAction={
        !disabled && appearance !== DEFAULT_PREVIEW_APPEARANCE ? (
          <SettingResetButton
            label="default browser appearance"
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
            aria-label="Default browser appearance"
          >
            <SelectValue>{APPEARANCE_LABELS[appearance]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(APPEARANCE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserRecordingFrameRateSetting({ disabled }: { readonly disabled: boolean }) {
  const frameRate = useClientSettings((settings) => settings.browserRecordingFrameRate);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-recording-frame-rate")}
      description="Maximum frame rate for browser recordings. 30 fps is the default and uses less CPU and storage; 60 fps captures smoother motion."
      resetAction={
        !disabled && frameRate !== DEFAULT_BROWSER_RECORDING_FRAME_RATE ? (
          <SettingResetButton
            label="browser recording frame rate"
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
            aria-label="Browser recording frame rate"
          >
            <SelectValue>{frameRate} fps</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {BROWSER_RECORDING_FRAME_RATES.map((rate) => (
              <SelectItem hideIndicator key={rate} value={String(rate)}>
                {rate} fps
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const LINK_TARGET_LABELS: Readonly<Record<BrowserLinkTarget, string>> = {
  system: "Your default browser",
  app: "T3 Code",
};

function BrowserLinkTargetSetting({ disabled }: { readonly disabled: boolean }) {
  const linkTarget = useClientSettings((settings) => settings.browserLinkTarget);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-link-target")}
      description="Where links in the chat and terminal open. Hold ⌘ or Ctrl while clicking a chat link to open it in your default browser either way."
      resetAction={
        !disabled && linkTarget !== DEFAULT_BROWSER_LINK_TARGET ? (
          <SettingResetButton
            label="link target"
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
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Open links in">
            <SelectValue>{LINK_TARGET_LABELS[linkTarget]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(Object.keys(LINK_TARGET_LABELS) as ReadonlyArray<BrowserLinkTarget>).map((target) => (
              <SelectItem hideIndicator key={target} value={target}>
                {LINK_TARGET_LABELS[target]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function AgentBrowserAccessSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("agent-browser-access")}
      description="Let agents open and drive the preview browser. When off, the browser tools and the instructions describing them are withheld from agent sessions. Your own browser panel is unaffected."
      status={
        settings.enableAgentBrowserAccess
          ? undefined
          : "Applies to sessions started from now on; a running agent keeps the tools it was given."
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label="agent browser access"
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(checked) =>
            updateSettings({ enableAgentBrowserAccess: Boolean(checked) })
          }
          aria-label="Allow agent browser access"
        />
      }
    />
  );
}

function BrowserAutoShowFloatingPreviewSetting({ disabled }: { readonly disabled: boolean }) {
  const autoShow = useClientSettings((settings) => settings.browserAutoShowFloatingPreview);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-auto-show-floating-preview")}
      description="Pop the floating preview into view when an agent opens a browser. An agent that explicitly asks to show or hide its preview still gets what it asked for."
      resetAction={
        !disabled && autoShow !== DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW ? (
          <SettingResetButton
            label="auto-show floating preview"
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
          aria-label="Auto-show floating preview"
        />
      }
    />
  );
}

/**
 * Frames the client-local preview defaults as one unavailable block.
 *
 * Disabling each control on its own left the labels and descriptions at full
 * strength, so the group still read as editable. Boxing it puts the reason at
 * the top and dims everything it covers, which is also why the explanation
 * sits outside the dimmed area — the one part that must stay readable is the
 * part saying why the rest isn't.
 *
 * Disabled rather than hidden because these are *client* settings: editing
 * them from a browser tab would write preferences belonging to a different
 * client, reading as though the desktop app had been configured when it
 * hadn't.
 */
function DesktopOnlyBrowserDefaults({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 py-1.5">
      <div className="flex items-start gap-2 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>Only available in the desktop app.</p>
      </div>
      <div className="[&_h3]:opacity-64 [&_p]:opacity-64">{children}</div>
    </div>
  );
}

/**
 * Create, rename, and remove browser profiles.
 *
 * Built-ins render without controls: they are synthesized rather than stored,
 * so there is nothing to rename and removing them would strand every tab that
 * opened under them.
 */
function BrowserProfilesSetting({ disabled }: { readonly disabled: boolean }) {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const [profilePendingRemoval, setProfilePendingRemoval] = useState<BrowserProfile | null>(null);
  const [profileRemovalError, setProfileRemovalError] = useState<string | null>(null);
  const [profileRemovalInFlight, setProfileRemovalInFlight] = useState(false);
  const removalAvailable = browserProfileRemovalAvailable(
    previewBridge !== null,
    environmentsReady,
    environments.length,
  );
  const profileWritesDisabled = disabled || !settingsHydrated;

  const addProfile = () => {
    if (!settingsHydrated) return;
    const currentProfiles = getClientSettings().browserProfiles;
    if (currentProfiles.length >= BROWSER_PROFILE_MAX_COUNT) return;
    const taken = new Set(resolveBrowserProfiles(currentProfiles).map((profile) => profile.name));
    let name = "New profile";
    for (let index = 2; taken.has(name); index += 1) name = `New profile ${index}`;
    updateSettings({
      browserProfiles: [
        ...currentProfiles,
        { id: `profile-${randomUUID()}`, name, kind: "persistent" as const },
      ],
    });
  };

  const renameProfile = (id: string, next: string) => {
    if (!settingsHydrated) return;
    const name = next.trim().slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH);
    if (name === "") return;
    const currentProfiles = getClientSettings().browserProfiles;
    updateSettings({
      browserProfiles: currentProfiles.map((profile) =>
        profile.id === id ? { ...profile, name } : profile,
      ),
    });
  };

  const removeProfile = async (id: string) => {
    if (!settingsHydrated) return;
    if (!removalAvailable) {
      setProfileRemovalError("Connect to an environment before removing this profile.");
      return;
    }
    setProfileRemovalError(null);
    setProfileRemovalInFlight(true);
    // Drop the partition's data too, otherwise a removed profile's cookies
    // stay on disk with nothing in the UI pointing at them.
    try {
      await clearBrowserProfileData(
        previewBridge,
        environmentsReady ? environments.map((environment) => environment.environmentId) : [],
        id,
      );
    } catch {
      setProfileRemovalError("Profile data could not be deleted. Try again.");
      setProfileRemovalInFlight(false);
      return;
    }
    const currentSettings = getClientSettings();
    updateSettings({
      browserProfiles: currentSettings.browserProfiles.filter((profile) => profile.id !== id),
      // Reassign the default rather than leaving it pointing at nothing.
      ...(currentSettings.browserDefaultProfileId === id
        ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
        : {}),
    });
    setProfileRemovalInFlight(false);
    setProfilePendingRemoval(null);
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-profiles")}
      description="Each profile keeps its own cookies and logins, so a tab opened under one can't see another's. Incognito discards everything when the app closes."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={profileWritesDisabled || userProfiles.length >= BROWSER_PROFILE_MAX_COUNT}
          onClick={addProfile}
        >
          <PlusIcon />
          Add profile
        </Button>
      }
    >
      {/*
        Each profile is its own bounded row, and the list carries the bottom
        spacing `SettingsRow` leaves to its children (`pt-3 pb-1`). Bare rows
        stack on narrow viewports with a larger gap inside a row than between
        rows, which reads as the remove button belonging to the profile below.
      */}
      <div className="mt-2 space-y-1 pb-2">
        {resolveBrowserProfiles(userProfiles).map((profile) => {
          const builtIn = isBuiltInBrowserProfileId(profile.id);
          return (
            <div
              key={profile.id}
              className={cn(
                ITEM_ROW_INNER_CLASSNAME,
                "rounded-lg border border-border/60 px-3 py-2",
              )}
            >
              {builtIn ? (
                // Dimmed here rather than on the list, which is the only
                // content in the row without a disabled treatment of its own:
                // a wrapper-level dim would stack with the rename field's and
                // the remove button's, landing them near 0.41 while every
                // other disabled control in the block sits at 0.64.
                <span
                  className={cn(
                    "flex min-w-0 items-center gap-2 text-sm text-foreground",
                    profileWritesDisabled && "opacity-64",
                  )}
                >
                  {profile.name}
                  <Badge variant="outline">
                    {profile.kind === "incognito" ? "Ephemeral" : "Built-in"}
                  </Badge>
                </span>
              ) : (
                <DraftInput
                  nativeInput
                  size="sm"
                  className="w-full sm:w-64"
                  aria-label={`Rename ${profile.name}`}
                  disabled={profileWritesDisabled}
                  maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH}
                  value={profile.name}
                  onCommit={(next) => renameProfile(profile.id, next)}
                />
              )}
              {builtIn ? null : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex" {...(!removalAvailable ? { tabIndex: 0 } : {})}>
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          disabled={profileWritesDisabled || !removalAvailable}
                          aria-label={`Remove ${profile.name}`}
                          onClick={() => setProfilePendingRemoval(profile)}
                        >
                          <Trash2Icon />
                        </Button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    {removalAvailable
                      ? "Remove profile and its data"
                      : "Connect to an environment to remove this profile"}
                  </TooltipPopup>
                </Tooltip>
              )}
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
            <AlertDialogTitle>Remove “{profilePendingRemoval?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its cookies, logins, and cache are deleted with it. Tabs already open in this profile
              stay open until you close them.
            </AlertDialogDescription>
            {profileRemovalError ? (
              <p aria-live="polite" className="text-sm text-destructive">
                {profileRemovalError}
              </p>
            ) : null}
            {!removalAvailable ? (
              <p className="text-sm text-muted-foreground">
                Connect to an environment to remove this profile and its data.
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={profileRemovalInFlight}
              render={<Button variant="outline" disabled={profileRemovalInFlight} />}
            >
              Cancel
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
              {profileRemovalInFlight ? "Removing…" : "Remove profile"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}

function BrowserDefaultProfileSetting({ disabled }: { readonly disabled: boolean }) {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const defaultProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();
  const profileWritesDisabled = disabled || !settingsHydrated;
  // Incognito is deliberately absent: as a default it would open every tab
  // into storage that is discarded on close.
  const profiles = resolveBrowserProfiles(userProfiles).filter(
    (profile) => profile.kind !== "incognito",
  );
  const selected = findBrowserProfile(profiles, defaultProfileId) ?? profiles[0];

  return (
    <SettingsRow
      {...searchableSetting("browser-default-profile")}
      description="Profile new browser tabs open under, including tabs an agent opens."
      resetAction={
        !profileWritesDisabled && defaultProfileId !== DEFAULT_BROWSER_PROFILE_ID ? (
          <SettingResetButton
            label="default browser profile"
            onClick={() => {
              if (settingsHydrated) {
                updateSettings({ browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID });
              }
            }}
          />
        ) : null
      }
      control={
        <Select
          disabled={profileWritesDisabled}
          value={selected?.id ?? DEFAULT_BROWSER_PROFILE_ID}
          onValueChange={(value) => {
            if (settingsHydrated && value !== null) {
              updateSettings({ browserDefaultProfileId: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Default browser profile">
            <SelectValue>{selected?.name ?? "Default"}</SelectValue>
          </SelectTrigger>
          {/*
            Capped and truncated like the tab menu's profile list: names are
            user-supplied and run to 48 characters, which would otherwise
            widen the popup to fit the longest one. The cap goes on the glass
            shell (`popupClassName`), and the list fills that shell so it is
            never narrower than the trigger it opens from — the same floor
            every other settings select keeps. `ItemText` renders a block, so
            the label must be a block too for `truncate` to apply.
          */}
          <SelectPopup
            align="end"
            alignItemWithTrigger={false}
            popupClassName="max-w-64"
            className="w-full"
          >
            {profiles.map((profile) => (
              <SelectItem hideIndicator key={profile.id} value={profile.id}>
                <span className="block min-w-0 truncate">{profile.name}</span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function IntegrationsSettingsPanel() {
  // Client-local preview defaults are editable only where the preview exists.
  const previewDefaultsDisabled = !isElectron;
  const previewDefaults = (
    <>
      <BrowserProfilesSetting disabled={previewDefaultsDisabled} />
      <BrowserDefaultProfileSetting disabled={previewDefaultsDisabled} />
      <BrowserViewportSetting disabled={previewDefaultsDisabled} />
      <BrowserZoomSetting disabled={previewDefaultsDisabled} />
      <BrowserAppearanceSetting disabled={previewDefaultsDisabled} />
      <BrowserRecordingFrameRateSetting disabled={previewDefaultsDisabled} />
      <BrowserLinkTargetSetting disabled={previewDefaultsDisabled} />
      <BrowserAutoShowFloatingPreviewSetting disabled={previewDefaultsDisabled} />
    </>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="browser" title="Browser">
        {/* Server-authoritative, so it stays editable on any client anchored to
            a server; `serverScoped` covers the hosted app, which has none. It
            sits outside the block covering the desktop-only defaults. */}
        <AgentBrowserAccessSetting />
        {previewDefaultsDisabled ? (
          <DesktopOnlyBrowserDefaults>{previewDefaults}</DesktopOnlyBrowserDefaults>
        ) : (
          previewDefaults
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
