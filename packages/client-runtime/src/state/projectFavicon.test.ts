import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import {
  forgetProjectFavicon,
  getLoadedProjectFavicon,
  rememberProjectFavicon,
  selectProjectFaviconSources,
  subscribeProjectFavicons,
} from "./projectFavicon.ts";
import { derivePhysicalProjectKey } from "./projectGrouping.ts";

const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(id: string, overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(`environment-${id}`),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectProjectFaviconSources", () => {
  it("selects the same source regardless of project order", () => {
    const first = makeProject("first");
    const second = makeProject("second", { updatedAt: "2026-07-02T00:00:00.000Z" });

    for (const projects of [
      [first, second],
      [second, first],
    ]) {
      const sources = selectProjectFaviconSources(projects);
      expect(sources.get(derivePhysicalProjectKey(first))).toEqual({
        projectKey: repositoryIdentity.canonicalKey,
        environmentId: second.environmentId,
        cwd: second.workspaceRoot,
        faviconPath: null,
      });
      expect(sources.get(derivePhysicalProjectKey(second))).toBe(
        sources.get(derivePhysicalProjectKey(first)),
      );
    }
  });

  it("prefers an explicit favicon over a newer automatic favicon", () => {
    const explicit = makeProject("explicit", { faviconPath: "/icons/project.svg" });
    const automatic = makeProject("automatic", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    expect(
      selectProjectFaviconSources([automatic, explicit]).get(derivePhysicalProjectKey(automatic)),
    ).toEqual({
      projectKey: repositoryIdentity.canonicalKey,
      environmentId: explicit.environmentId,
      cwd: explicit.workspaceRoot,
      faviconPath: "/icons/project.svg",
    });
  });

  it("uses the creation time when the update time is invalid", () => {
    const older = makeProject("older", {
      updatedAt: "invalid",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const newer = makeProject("newer", {
      updatedAt: "invalid",
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(
      selectProjectFaviconSources([older, newer]).get(derivePhysicalProjectKey(older))
        ?.environmentId,
    ).toBe(newer.environmentId);
  });

  it("breaks equal timestamps with a stable physical project key", () => {
    const alpha = makeProject("alpha");
    const beta = makeProject("beta");

    for (const projects of [
      [alpha, beta],
      [beta, alpha],
    ]) {
      expect(
        selectProjectFaviconSources(projects).get(derivePhysicalProjectKey(beta))?.environmentId,
      ).toBe(alpha.environmentId);
    }
  });

  it("keeps projects without repository identity scoped to their physical path", () => {
    const first = makeProject("first", { repositoryIdentity: null });
    const second = makeProject("second", { repositoryIdentity: null });
    const sources = selectProjectFaviconSources([first, second]);

    expect(sources.get(derivePhysicalProjectKey(first))).toEqual({
      projectKey: derivePhysicalProjectKey(first),
      environmentId: first.environmentId,
      cwd: first.workspaceRoot,
      faviconPath: null,
    });
    expect(sources.get(derivePhysicalProjectKey(second))?.environmentId).toBe(second.environmentId);
  });
});

describe("loaded project favicons", () => {
  it("returns null when a favicon has not loaded", () => {
    expect(getLoadedProjectFavicon("missing-project")).toBeNull();
  });

  it("ignores stale image errors when a newer image has loaded", () => {
    const projectKey = "conditional-forget-project";
    const favicon = { cacheKey: "revision-two", src: "/icons/two.svg" };
    rememberProjectFavicon(projectKey, favicon);

    forgetProjectFavicon(projectKey, "/icons/one.svg");
    expect(getLoadedProjectFavicon(projectKey)).toEqual(favicon);

    forgetProjectFavicon(projectKey, favicon.src);
    expect(getLoadedProjectFavicon(projectKey)).toBeNull();
  });

  it("notifies subscribers only when the stored favicon changes", () => {
    const projectKey = "subscription-project";
    const favicon = { cacheKey: "revision-one", src: "/icons/one.svg" };
    const listener = vi.fn();
    const unsubscribe = subscribeProjectFavicons(projectKey, listener);

    rememberProjectFavicon(projectKey, favicon);
    rememberProjectFavicon(projectKey, { ...favicon });
    forgetProjectFavicon(projectKey, "/icons/old.svg");
    rememberProjectFavicon("unrelated-project", favicon);

    expect(listener).toHaveBeenCalledTimes(1);

    forgetProjectFavicon(projectKey);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    rememberProjectFavicon(projectKey, favicon);
    expect(listener).toHaveBeenCalledTimes(2);
    forgetProjectFavicon(projectKey);
    forgetProjectFavicon("unrelated-project");
  });

  it("evicts the oldest favicon after the cache reaches its limit", () => {
    const oldestProjectKey = "bounded-project-0";
    const oldestProjectListener = vi.fn();
    const unsubscribe = subscribeProjectFavicons(oldestProjectKey, oldestProjectListener);

    for (let index = 0; index <= 256; index++) {
      rememberProjectFavicon(`bounded-project-${index}`, {
        cacheKey: `revision-${index}`,
        src: `/icons/${index}.svg`,
      });
    }

    expect(getLoadedProjectFavicon(oldestProjectKey)).toBeNull();
    expect(getLoadedProjectFavicon("bounded-project-256")).toEqual({
      cacheKey: "revision-256",
      src: "/icons/256.svg",
    });
    expect(oldestProjectListener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
