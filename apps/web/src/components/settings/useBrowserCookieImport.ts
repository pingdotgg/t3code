import {
  BROWSER_PROFILE_MAX_COUNT,
  type BrowserImportSource,
  type EnvironmentId,
  managedCapabilityDenial,
  resolveBrowserProfiles,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import { previewBridge } from "~/components/preview/previewBridge";
import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { usePrimaryEnvironment } from "~/state/environments";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";

import { toastManager } from "../ui/toast";
import type { WizardTarget } from "./BrowserImportWizard";
import type { ImportOutcome } from "./browserImportWizard.logic";
import { importBrowserCookiesIntoTarget } from "./IntegrationsSettings";

export interface BrowserImportSession {
  readonly source: BrowserImportSource;
  readonly environmentId: EnvironmentId;
  readonly environmentName: string;
}

function filterImportableBrowserSources(
  sources: ReadonlyArray<BrowserImportSource> | null,
): ReadonlyArray<BrowserImportSource> {
  return (sources ?? []).filter(
    (source) =>
      source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform",
  );
}

export function useBrowserCookieImport(options?: {
  readonly onImported?: (target: WizardTarget) => void;
}) {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const settingsHydrated = useClientSettingsHydrated();
  const primaryEnvironment = usePrimaryEnvironment();
  // Cookie import runs on this desktop, whose policy the primary environment reports.
  const cookieImportDenial = managedCapabilityDenial(
    usePrimaryManagedPolicy(),
    "browserCookieImport",
  );
  const [sources, setSources] = useState<ReadonlyArray<BrowserImportSource> | null>(null);
  const [importSession, setImportSession] = useState<BrowserImportSession | null>(null);
  const importInFlightRef = useRef(false);
  const [importInFlight, setImportInFlight] = useState(false);

  const profiles = resolveBrowserProfiles(userProfiles);
  const listedProfiles = profiles.filter((profile) => profile.kind !== "incognito");
  const atProfileLimit = userProfiles.length >= BROWSER_PROFILE_MAX_COUNT;
  const importableSources = filterImportableBrowserSources(sources);

  const loadSources = () => {
    if (!previewBridge) return;
    void previewBridge
      .listBrowserImportSources()
      .then(setSources)
      .catch(() => setSources((previous) => previous ?? []));
  };

  const startImportSession = (source: BrowserImportSource) => {
    if (!settingsHydrated || primaryEnvironment == null || importInFlightRef.current) return;
    setImportSession({
      source,
      environmentId: primaryEnvironment.environmentId,
      environmentName: resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: primaryEnvironment.environmentId,
        runtimeLabel: primaryEnvironment.label,
      }),
    });
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
    return importBrowserCookiesIntoTarget(previewBridge, source, environmentId, input)
      .then((outcome) => {
        if (outcome.kind === "imported" && outcome.imported > 0) {
          options?.onImported?.(input.target);
        }
        return outcome;
      })
      .finally(() => {
        importInFlightRef.current = false;
        setImportInFlight(false);
      });
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

  const openFullDiskAccessSettings = async () => {
    await readLocalApi()
      ?.shell.openSystemSettings("full-disk-access")
      .catch(() => {
        toastManager.add({
          type: "error",
          title: "Could not open System Settings",
          description: "Open Privacy & Security → Full Disk Access manually.",
        });
      });
  };

  return {
    sources,
    importableSources,
    importSession,
    setImportSession,
    importInFlight,
    importInFlightRef,
    cookieImportDenial,
    primaryEnvironment,
    settingsHydrated,
    listedProfiles,
    atProfileLimit,
    loadSources,
    startImportSession,
    runWizardImport,
    refreshImportSource,
    openFullDiskAccessSettings,
  };
}
