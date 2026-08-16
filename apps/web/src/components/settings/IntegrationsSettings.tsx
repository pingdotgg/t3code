/**
 * Integrations settings - preferences for surfaces T3 Code embeds rather than
 * owns. Browser is the first section: the defaults a preview tab opens at,
 * applied to both hand-opened tabs and agent `preview_open` calls that don't
 * state their own size.
 *
 * @module IntegrationsSettings
 */
import {
  BROWSER_IMPORT_FAILURE_COPY,
  BROWSER_IMPORT_UNAVAILABLE_COPY,
  BrowserImportFailureReason,
  BROWSER_PROFILE_MAX_COUNT,
  type BrowserProfile,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_PROFILE_ID,
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
  type BrowserImportSource,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import { InfoIcon, MoreVertical, Plus as PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ScreenRotationIcon } from "~/browser/ScreenRotationIcon";
import { previewBridge } from "~/components/preview/previewBridge";
import { cn, randomUUID } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { isElectron } from "../../env";

import { Badge } from "../ui/badge";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
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
  useClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const FILL_VALUE = "fill";
const RESPONSIVE_VALUE = "responsive";

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

/**
 * IPC flattens the failure to its message, so the reason token travels inside
 * it. Anything unrecognised reads as a plain read failure rather than leaking
 * the raw message into a toast.
 */
const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

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
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser zoom">
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
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser appearance">
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

function AgentBrowserAccessSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
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
 * Profile list, its header menu, and the import flow.
 *
 * One menu creates profiles and imports into them, because the two are the
 * same decision from the user's side: "I want a profile that has my Helium
 * logins in it". Import targets include "New profile" so that case does not
 * require creating one first and then finding a second control.
 *
 * Built-ins render without a rename field: they are synthesized rather than
 * stored, so there is nothing to rename and removing them would strand every
 * tab that opened under them.
 *
 * Sources are listed lazily on open: detection touches the other browser's
 * files, and the answer changes while the app is running (quitting the browser
 * clears `browserRunning`), so a value cached at mount would go stale.
 */
function BrowserProfilesSetting({ disabled }: { readonly disabled: boolean }) {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const defaultProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const updateSettings = useUpdatePrimarySettings();
  const environmentId = usePrimaryEnvironment()?.environmentId;
  const [sources, setSources] = useState<ReadonlyArray<BrowserImportSource> | null>(null);
  const [busy, setBusy] = useState(false);
  const [profilePendingRemoval, setProfilePendingRemoval] = useState<BrowserProfile | null>(null);

  const profiles = resolveBrowserProfiles(userProfiles);
  // Incognito is deliberately not a row — it holds nothing to manage — so the
  // default has to resolve against the list that renders. A stored
  // `browserDefaultProfileId` of "incognito" would otherwise leave the section
  // with no Default badge at all.
  const listedProfiles = profiles.filter((profile) => profile.kind !== "incognito");
  const resolvedDefaultId =
    findBrowserProfile(listedProfiles, defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID;

  const uniqueName = (base: string) => {
    const taken = new Set(profiles.map((profile) => profile.name));
    if (!taken.has(base)) return base;
    for (let index = 2; ; index += 1) {
      const candidate = `${base} ${index}`;
      if (!taken.has(candidate)) return candidate;
    }
  };

  const createProfile = (name: string) => {
    const profile = {
      id: `profile-${randomUUID()}`,
      name: uniqueName(name),
      kind: "persistent" as const,
    };
    updateSettings({ browserProfiles: [...userProfiles, profile] });
    return profile;
  };

  const renameProfile = (id: string, next: string) => {
    const name = next.trim().slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH);
    if (name === "") return;
    updateSettings({
      browserProfiles: userProfiles.map((profile) =>
        profile.id === id ? { ...profile, name } : profile,
      ),
    });
  };

  const clearProfileData = (id: string, name: string) => {
    if (!environmentId || !previewBridge) return;
    void Promise.all([
      previewBridge.clearCookies(environmentId, id),
      previewBridge.clearCache(environmentId, id),
    ])
      .then(() => {
        toastManager.add({ type: "success", title: `Cleared ${name}'s cookies and cache` });
      })
      .catch(() => {
        toastManager.add({ type: "error", title: `Could not clear ${name}'s data` });
      });
  };

  const removeProfile = (id: string) => {
    setProfilePendingRemoval(null);
    // Drop the partition's data too, otherwise a removed profile's cookies
    // stay on disk with nothing in the UI pointing at them.
    if (environmentId) {
      void previewBridge?.clearCookies(environmentId, id).catch(() => undefined);
      void previewBridge?.clearCache(environmentId, id).catch(() => undefined);
    }
    updateSettings({
      browserProfiles: userProfiles.filter((profile) => profile.id !== id),
      ...(defaultProfileId === id ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID } : {}),
    });
  };

  const loadSources = () => {
    if (!previewBridge) return;
    // Cleared first: availability changes while the app runs (quitting a
    // browser clears `browserRunning`), and showing the previous answer during
    // the refresh lets the user start an import the source no longer supports.
    setSources(null);
    void previewBridge
      .listBrowserImportSources()
      .then(setSources)
      .catch(() => setSources([]));
  };

  const runImport = (
    source: BrowserImportSource,
    sourceProfileDirectory: string,
    targetProfileId: string,
    targetName: string,
  ) => {
    if (!environmentId || !previewBridge) return;
    setBusy(true);
    void previewBridge
      .importBrowserCookies({
        environmentId,
        sourceId: source.id,
        sourceProfileDirectory,
        targetProfileId,
      })
      .then((result) => {
        toastManager.add({
          type: result.imported > 0 ? "success" : "error",
          title:
            result.imported > 0
              ? `Imported ${result.imported} cookies into ${targetName}`
              : `No cookies imported from ${source.name}`,
          // Surfaced rather than hidden: a mostly-skipped import should not
          // read as a clean success.
          ...(result.skipped > 0 ? { description: `${result.skipped} skipped.` } : {}),
        });
      })
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: `Could not import from ${source.name}`,
          description: BROWSER_IMPORT_FAILURE_COPY[importFailureReason(cause)],
        });
      })
      .finally(() => setBusy(false));
  };

  const importInto = (
    source: BrowserImportSource,
    sourceProfileDirectory: string,
    target: "new" | { readonly id: string; readonly name: string },
  ) => {
    if (target === "new") {
      const created = createProfile(source.name);
      runImport(source, sourceProfileDirectory, created.id, created.name);
      return;
    }
    runImport(source, sourceProfileDirectory, target.id, target.name);
  };

  const atProfileLimit = userProfiles.length >= BROWSER_PROFILE_MAX_COUNT;

  return (
    <SettingsRow
      {...searchableSetting("browser-profiles")}
      description="Each profile keeps its own cookies and logins, so a tab opened under one can't see another's. Incognito isn't listed here — it keeps nothing, and you pick it when opening a tab."
      control={
        <Menu onOpenChange={(open) => open && loadSources()}>
          <MenuTrigger render={<Button size="sm" variant="outline" disabled={disabled || busy} />}>
            <PlusIcon />
            Add profile
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-56">
            <MenuItem disabled={atProfileLimit} onClick={() => createProfile("New profile")}>
              Blank profile
            </MenuItem>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Import from</MenuGroupLabel>
              {sources === null ? (
                <MenuItem disabled>Looking for browsers…</MenuItem>
              ) : sources.length === 0 ? (
                <MenuItem disabled>No supported browsers found</MenuItem>
              ) : (
                sources.flatMap((source) =>
                  source.unavailable
                    ? [
                        // Kept visible with its reason rather than hidden:
                        // "Helium is running, quit it" beats "Helium isn't
                        // listed".
                        <MenuItem key={source.id} disabled>
                          <span className="flex flex-col items-start">
                            <span>{source.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {BROWSER_IMPORT_UNAVAILABLE_COPY[source.unavailable]}
                            </span>
                          </span>
                        </MenuItem>,
                      ]
                    : source.profiles.map((sourceProfile) => (
                        <MenuSub key={`${source.id}:${sourceProfile.directory}`}>
                          <MenuSubTrigger>
                            {source.profiles.length > 1
                              ? `${source.name} — ${sourceProfile.name}`
                              : source.name}
                          </MenuSubTrigger>
                          <MenuSubPopup className="min-w-44">
                            <MenuItem
                              disabled={atProfileLimit}
                              onClick={() => importInto(source, sourceProfile.directory, "new")}
                            >
                              New profile
                            </MenuItem>
                            <MenuSeparator />
                            <MenuGroup>
                              <MenuGroupLabel>Existing profile</MenuGroupLabel>
                              {profiles
                                // Incognito is discarded on quit, so importing
                                // into it would throw the work away.
                                .filter((profile) => profile.kind !== "incognito")
                                .map((profile) => (
                                  <MenuItem
                                    key={profile.id}
                                    onClick={() =>
                                      importInto(source, sourceProfile.directory, {
                                        id: profile.id,
                                        name: profile.name,
                                      })
                                    }
                                  >
                                    {profile.name}
                                  </MenuItem>
                                ))}
                            </MenuGroup>
                          </MenuSubPopup>
                        </MenuSub>
                      )),
                )
              )}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      }
    >
      {/*
        Dimmed as a whole when the section is unavailable. The built-in rows
        are a plain span and a badge rather than `h3`/`p` or disabled controls,
        so the block's own dimming does not reach them and they would be the
        only full-contrast content inside "only available in the desktop app".
      */}
      <div
        className={cn(
          "mt-2 overflow-hidden rounded-lg border border-border/60",
          disabled && "opacity-64",
        )}
      >
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
                  <span className="truncate text-sm text-foreground">{profile.name}</span>
                ) : (
                  <DraftInput
                    nativeInput
                    size="sm"
                    className="w-full max-w-56"
                    aria-label={`Rename ${profile.name}`}
                    disabled={disabled}
                    maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH}
                    value={profile.name}
                    onCommit={(next) => renameProfile(profile.id, next)}
                  />
                )}
                {isDefault ? <Badge>Default</Badge> : null}
              </span>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={disabled}
                      aria-label={`${profile.name} options`}
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-44">
                  <MenuItem
                    disabled={isDefault}
                    onClick={() => updateSettings({ browserDefaultProfileId: profile.id })}
                  >
                    Set as default
                  </MenuItem>
                  <MenuItem onClick={() => clearProfileData(profile.id, profile.name)}>
                    Clear cookies and cache
                  </MenuItem>
                  {builtIn ? null : (
                    <MenuItem
                      variant="destructive"
                      onClick={() => setProfilePendingRemoval(profile)}
                    >
                      Remove profile and data
                    </MenuItem>
                  )}
                </MenuPopup>
              </Menu>
            </div>
          );
        })}
      </div>
      <AlertDialog
        open={profilePendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setProfilePendingRemoval(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{profilePendingRemoval?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its cookies, logins, and cache are deleted with it. Tabs open in this profile move to
              the default one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (profilePendingRemoval) removeProfile(profilePendingRemoval.id);
              }}
            >
              Remove profile
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}

export function IntegrationsSettingsPanel() {
  // Client-local preview defaults are editable only where the preview exists.
  const previewDefaultsDisabled = !isElectron;
  const previewDefaults = (
    <>
      <BrowserProfilesSetting disabled={previewDefaultsDisabled} />
      <BrowserViewportSetting disabled={previewDefaultsDisabled} />
      <BrowserZoomSetting disabled={previewDefaultsDisabled} />
      <BrowserAppearanceSetting disabled={previewDefaultsDisabled} />
      <BrowserAutoShowFloatingPreviewSetting disabled={previewDefaultsDisabled} />
    </>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="browser" title="Browser">
        {/* Server-authoritative, so it stays editable on every client and sits
            outside the block covering the desktop-only defaults. */}
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
