import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  INCOGNITO_BROWSER_PROFILE_ID,
  ProjectId,
  type RepositoryIdentity,
} from "@t3tools/contracts";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => settings.current,
  useClientSettings: () => undefined,
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
}));

const {
  getBrowserDefaults,
  projectBrowserProfileKey,
  projectProfileIdsForEnvironment,
  resolveDefaultBrowserProfileId,
} = await import("./browserDefaults");

const withDefaultProfile = (browserDefaultProfileId: string) => {
  settings.current = {
    browserDefaultViewport: { _tag: "fill" },
    browserDefaultZoomFactor: 1,
    browserDefaultAppearance: "system",
    browserAutoShowFloatingPreview: true,
    browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
    browserDefaultProfileId,
  };
  return getBrowserDefaults();
};

describe("getBrowserDefaults profile resolution", () => {
  it("refuses incognito as the default", () => {
    expect(withDefaultProfile(INCOGNITO_BROWSER_PROFILE_ID).profileId).toBe(
      DEFAULT_BROWSER_PROFILE_ID,
    );
  });
});

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const repository = {
  canonicalKey: "github.com/acme/app",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/app.git" },
} as unknown as RepositoryIdentity;
const checkout = (environmentId: EnvironmentId, workspaceRoot: string, identity = repository) => ({
  id: ProjectId.make(`${environmentId}:${workspaceRoot}`),
  environmentId,
  workspaceRoot,
  repositoryIdentity: identity,
});
const profileSettings = (browserProjectProfileIds: Record<string, string>) => ({
  browserProfiles: [
    { id: "work", name: "Work", kind: "persistent" as const },
    { id: "personal", name: "Personal", kind: "persistent" as const },
  ],
  browserDefaultProfileId: "personal",
  browserProjectProfileIds,
});

describe("project browser profiles", () => {
  const main = checkout(local, "/repo");
  const workKey = projectBrowserProfileKey(main);

  it("applies one repository choice to its worktrees and other environments", () => {
    const settings = profileSettings({ [workKey]: "work" });
    for (const project of [
      main,
      checkout(local, "/worktrees/app/feature"),
      checkout(remote, "/srv/app"),
    ])
      expect(resolveDefaultBrowserProfileId(settings, project)).toBe("work");
  });

  it("keys a folder without a repository by its checkout", () => {
    const folder = checkout(local, "/notes", null as unknown as RepositoryIdentity);
    const settings = profileSettings({ [projectBrowserProfileKey(folder)]: "work" });
    expect(resolveDefaultBrowserProfileId(settings, folder)).toBe("work");
    expect(
      resolveDefaultBrowserProfileId(
        settings,
        checkout(remote, "/notes", null as unknown as RepositoryIdentity),
      ),
    ).toBe("personal");
  });

  it.each([
    ["no project", null, { [workKey]: "work" }],
    ["no choice", main, {}],
    ["a removed profile", main, { [workKey]: "deleted" }],
    ["incognito", main, { [workKey]: INCOGNITO_BROWSER_PROFILE_ID }],
  ])("falls back to the global default with %s", (_, project, choices) => {
    expect(resolveDefaultBrowserProfileId(profileSettings(choices), project)).toBe("personal");
  });

  it("reports an environment's projects by their ids, dropping unusable choices", () => {
    const other = checkout(local, "/other", {
      ...repository,
      canonicalKey: "github.com/acme/other",
    });
    const settings = profileSettings({
      [workKey]: "work",
      [projectBrowserProfileKey(other)]: "deleted",
    });
    const remoteCheckout = checkout(remote, "/srv/app");
    expect(
      projectProfileIdsForEnvironment(settings, remote, [main, other, remoteCheckout]),
    ).toEqual({
      [remoteCheckout.id]: "work",
    });
  });
});
