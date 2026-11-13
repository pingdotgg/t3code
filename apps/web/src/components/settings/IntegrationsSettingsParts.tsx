import { DeviceHostUpdates } from "../device/DeviceHostUpdates";
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
import type { ServerProfileData } from "./IntegrationsSettings";
import { browserProfileRemovalAvailable, clearBrowserProfileData, importBrowserCookiesIntoTarget } from "./IntegrationsSettings";

export function BrowserProfilesSetting({ disabled }: { readonly disabled: boolean }) {
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
        title: `Could not clear ${name}'s data`,
        description: "You're not connected to a server yet.",
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
        toastManager.add({ type: "success", title: `Cleared ${name}'s cookies and cache` });
      })
      .catch(() => {
        toastManager.add({ type: "error", title: `Could not clear ${name}'s data` });
      });
  };

  const removeProfile = async (id: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    if (!removalAvailable) {
      setProfileRemovalError("Connect to an environment before removing this profile.");
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
      setProfileRemovalError("Profile data could not be deleted. Try again.");
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
      description="Profiles separate cookies and logins. Incognito data is cleared when the app closes."
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
            Add profile
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={!settingsHydrated || atProfileLimit}
              onClick={() => createProfile("New profile")}
            >
              Blank profile
            </MenuItem>
            {atProfileLimit ? (
              <MenuItem disabled>You&rsquo;ve reached the profile limit</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Import from</MenuGroupLabel>
              {cookieImportDenial !== undefined ? (
                <MenuItem disabled>{cookieImportDenial}</MenuItem>
              ) : sources === null ? (
                <MenuItem disabled>Looking for browsers…</MenuItem>
              ) : importableSources.length === 0 ? (
                <MenuItem disabled>No supported browsers found</MenuItem>
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
                    <MenuItem disabled>Connect to an environment to import cookies</MenuItem>
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
                    aria-label={`Rename ${profile.name}`}
                    disabled={profileWritesDisabled || importInFlight}
                    maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH}
                    value={profile.name}
                    onCommit={(next) => renameProfile(profile.id, next)}
                  />
                )}
                {isDefault ? (
                  <span className={cn("flex", profileWritesDisabled && "opacity-64")}>
                    <Badge>Default</Badge>
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
                      aria-label={`${profile.name} options`}
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
                    Set as default
                  </MenuItem>
                  <MenuItem
                    disabled={!settingsHydrated || !removalAvailable}
                    onClick={() => {
                      if (serverProfileData.environmentIds.length > 0) {
                        setProfilePendingClear(profile);
                      } else clearProfileData(profile.id, profile.name);
                    }}
                  >
                    Clear cookies and cache
                  </MenuItem>
                  {builtIn ? null : (
                    <MenuItem
                      variant="destructive"
                      disabled={!settingsHydrated || !removalAvailable}
                      onClick={() => {
                        if (settingsHydrated) setProfilePendingRemoval(profile);
                      }}
                    >
                      Remove profile and data
                    </MenuItem>
                  )}
                  {!removalAvailable ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled>
                        {environmentsReady
                          ? "Connect to an environment to clear profile data"
                          : "Checking environments…"}
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
            <AlertDialogTitle>Remove “{profilePendingRemoval?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its cookies and logins are deleted. Desktop tabs already open in this profile stay
              open until you close them; server browser tabs close now.
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
      <AlertDialog
        open={profilePendingClear !== null}
        onOpenChange={(open) => {
          if (!open) setProfilePendingClear(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clear “{profilePendingClear?.name}”’s cookies and cache?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are signed out of its sites. Server browser tabs open in this profile close now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (profilePendingClear)
                  clearProfileData(profilePendingClear.id, profilePendingClear.name);
                setProfilePendingClear(null);
              }}
            >
              Clear data
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
                  title: "Could not open System Settings",
                  description: "Open Privacy & Security → Full Disk Access manually.",
                });
              });
          }}
          onClose={() => setImportSession(null)}
        />
      ) : null}
    </SettingsRow>
  );
}

