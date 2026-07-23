import { describe, expect, it } from "vite-plus/test";

import { projectFaviconSettingsRevision } from "./ProjectFavicon";

describe("projectFaviconSettingsRevision", () => {
  it("stays bounded for large remote icon maps", () => {
    const projectIconsByGitRemote = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `github.com/example/${"r".repeat(900)}-${index}`,
        `/icons/${"i".repeat(900)}-${index}.svg`,
      ]),
    );

    const revision = projectFaviconSettingsRevision(
      { projectIcons: {}, projectIconsByGitRemote },
      "/workspace/project",
    );

    expect(revision).toBeDefined();
    expect(revision?.length).toBeLessThanOrEqual(1024);
  });

  it("is stable across remote map insertion order and changes with icon settings", () => {
    const first = projectFaviconSettingsRevision(
      {
        projectIcons: {},
        projectIconsByGitRemote: {
          "github.com/example/two": "/icons/two.svg",
          "github.com/example/one": "/icons/one.svg",
        },
      },
      "/workspace/project",
    );
    const reordered = projectFaviconSettingsRevision(
      {
        projectIcons: {},
        projectIconsByGitRemote: {
          "github.com/example/one": "/icons/one.svg",
          "github.com/example/two": "/icons/two.svg",
        },
      },
      "/workspace/project",
    );
    const changed = projectFaviconSettingsRevision(
      {
        projectIcons: {},
        projectIconsByGitRemote: {
          "github.com/example/one": "/icons/one-next.svg",
          "github.com/example/two": "/icons/two.svg",
        },
      },
      "/workspace/project",
    );

    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
  });

  it("uses only the higher-precedence workspace icon when configured", () => {
    const first = projectFaviconSettingsRevision(
      {
        projectIcons: { "/workspace/project": "/icons/local.svg" },
        projectIconsByGitRemote: { "github.com/example/one": "/icons/one.svg" },
      },
      "/workspace/project",
    );
    const remoteChanged = projectFaviconSettingsRevision(
      {
        projectIcons: { "/workspace/project": "/icons/local.svg" },
        projectIconsByGitRemote: { "github.com/example/one": "/icons/one-next.svg" },
      },
      "/workspace/project",
    );

    expect(remoteChanged).toBe(first);
  });
});
