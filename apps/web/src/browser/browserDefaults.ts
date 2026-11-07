import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  repositoryGroupingKeyOf,
  resolveBrowserProfiles,
  type BrowserProfile,
  type DesktopPreviewTabDefaults,
  type EnvironmentId,
  type ProjectId,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  useClientSettings,
} from "~/hooks/useSettings";

import { readProject, readThreadShell, useProject, useQuietThreadShell } from "~/state/entities";

import { resolveResponsiveBrowserViewportSize } from "./browserViewportLayout";

export interface BrowserDefaults {
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly appearance: PreviewAppearancePreference;
  readonly autoShowFloatingPreview: boolean;
  readonly profiles: ReadonlyArray<BrowserProfile>;
  readonly profileId: string;
}

export type BrowserProfileProject = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "repositoryIdentity"
>;

/**
 * One choice covers every checkout of a repository, on every environment, so worktrees and
 * remote clones follow it. A folder without a repository identity is keyed by its own path.
 */
export function projectBrowserProfileKey(project: BrowserProfileProject): string {
  return project.repositoryIdentity
    ? `repository:${repositoryGroupingKeyOf(project.repositoryIdentity)}`
    : `checkout:${derivePhysicalProjectKey(project)}`;
}

interface BrowserProfileSettings {
  readonly browserProfiles: ReadonlyArray<BrowserProfile>;
  readonly browserDefaultProfileId: string;
  readonly browserProjectProfileIds: Readonly<Record<string, string>>;
}

const openableProfileId = (profiles: ReadonlyArray<BrowserProfile>, id: string | undefined) =>
  id === undefined
    ? undefined
    : profiles.find((profile) => profile.id === id && profile.kind !== "incognito")?.id;

/** The profile a tab opens in when nothing names one: the project's, then the global default. */
export function resolveDefaultBrowserProfileId(
  settings: BrowserProfileSettings,
  project: BrowserProfileProject | null,
  profiles: ReadonlyArray<BrowserProfile> = resolveBrowserProfiles(settings.browserProfiles),
): string {
  return (
    (project
      ? openableProfileId(
          profiles,
          settings.browserProjectProfileIds[projectBrowserProfileKey(project)],
        )
      : undefined) ??
    openableProfileId(profiles, settings.browserDefaultProfileId) ??
    DEFAULT_BROWSER_PROFILE_ID
  );
}

/** Projects on one environment whose own profile replaces the default for tabs agents open there. */
export function projectProfileIdsForEnvironment(
  settings: BrowserProfileSettings,
  environmentId: EnvironmentId,
  projects: ReadonlyArray<BrowserProfileProject & Pick<EnvironmentProject, "id">>,
): Record<ProjectId, string> {
  const profiles = resolveBrowserProfiles(settings.browserProfiles);
  const result: Record<ProjectId, string> = {};
  for (const project of projects) {
    if (project.environmentId !== environmentId) continue;
    const profileId = openableProfileId(
      profiles,
      settings.browserProjectProfileIds[projectBrowserProfileKey(project)],
    );
    if (profileId !== undefined) result[project.id] = profileId;
  }
  return result;
}

const toBrowserDefaults = (
  settings: BrowserProfileSettings & {
    readonly browserDefaultViewport: PreviewViewportSetting;
    readonly browserDefaultZoomFactor: number;
    readonly browserDefaultAppearance: PreviewAppearancePreference;
    readonly browserAutoShowFloatingPreview: boolean;
  },
  project: BrowserProfileProject | null,
): BrowserDefaults => {
  const profiles = resolveBrowserProfiles(settings.browserProfiles);
  return {
    viewport: settings.browserDefaultViewport,
    zoomFactor: settings.browserDefaultZoomFactor,
    appearance: settings.browserDefaultAppearance,
    autoShowFloatingPreview: settings.browserAutoShowFloatingPreview,
    profiles,
    profileId: resolveDefaultBrowserProfileId(settings, project, profiles),
  };
};

// A draft has no thread shell until its first message, but already belongs to a project.
function readThreadProject(threadRef: ScopedThreadRef | undefined): EnvironmentProject | null {
  const owner = threadRef
    ? (readThreadShell(threadRef) ??
      useComposerDraftStore.getState().getDraftThreadByRef(threadRef))
    : null;
  return owner ? readProject(scopeProjectRef(owner.environmentId, owner.projectId)) : null;
}

/** Pass the thread a new tab opens in so its project's profile applies. */
export function getBrowserDefaults(threadRef?: ScopedThreadRef): BrowserDefaults {
  return toBrowserDefaults(getClientSettings(), readThreadProject(threadRef));
}

/** New tabs retain their initial defaults, so wait for settings hydration. Read failures reject. */
export async function resolveBrowserDefaults(
  threadRef?: ScopedThreadRef,
): Promise<BrowserDefaults> {
  await ensureClientSettingsHydrated();
  return getBrowserDefaults(threadRef);
}

export function useBrowserDefaults(threadRef?: ScopedThreadRef | null): BrowserDefaults {
  const shell = useQuietThreadShell(threadRef ?? null);
  const draft = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const owner = shell ?? draft;
  const project = useProject(owner ? scopeProjectRef(owner.environmentId, owner.projectId) : null);
  return useClientSettings((settings) => toBrowserDefaults(settings, project));
}

export function browserDefaultTabState(defaults: BrowserDefaults): DesktopPreviewTabDefaults {
  return { zoomFactor: defaults.zoomFactor, colorScheme: defaults.appearance };
}

const FALLBACK_RESPONSIVE_VIEWPORT_SIZE = { width: 1024, height: 768 } as const;

export function browserResponsiveViewportForToggle(input: {
  readonly defaults?: BrowserDefaults;
  readonly panelRect: { readonly width: number; readonly height: number } | null;
  readonly zoomFactor: number | undefined;
}): PreviewViewportSetting {
  const defaults = input.defaults ?? getBrowserDefaults();
  if (defaults.viewport._tag !== "fill") return defaults.viewport;
  const size = input.panelRect
    ? resolveResponsiveBrowserViewportSize(input.panelRect, input.zoomFactor)
    : FALLBACK_RESPONSIVE_VIEWPORT_SIZE;
  return { _tag: "freeform", ...size };
}
