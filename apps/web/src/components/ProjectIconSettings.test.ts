import { describe, expect, it } from "vite-plus/test";

import { replaceProjectIconSetting } from "./ProjectIconSettings";

describe("replaceProjectIconSetting", () => {
  it("sets and trims a project icon without changing other projects", () => {
    expect(
      replaceProjectIconSetting(
        {
          projectIcons: { "/workspace/one": "/icons/one.svg" },
          projectIconsByGitRemote: {},
        },
        { workspaceRoot: "/workspace/two" },
        "workspace",
        "  ~/icons/two.svg  ",
      ),
    ).toEqual({
      projectIcons: {
        "/workspace/one": "/icons/one.svg",
        "/workspace/two": "~/icons/two.svg",
      },
      projectIconsByGitRemote: {},
    });
  });

  it("removes only the selected project when the path is blank", () => {
    expect(
      replaceProjectIconSetting(
        {
          projectIcons: {
            "/workspace/one": "/icons/one.svg",
            "/workspace/two": "/icons/two.svg",
          },
          projectIconsByGitRemote: {},
        },
        { workspaceRoot: "/workspace/one" },
        "workspace",
        " ",
      ),
    ).toEqual({
      projectIcons: { "/workspace/two": "/icons/two.svg" },
      projectIconsByGitRemote: {},
    });
  });

  it("sets a portable git-remote icon and removes the local path override", () => {
    expect(
      replaceProjectIconSetting(
        {
          projectIcons: {
            "/workspace/one": "/icons/local.svg",
            "/workspace/two": "/icons/two.svg",
          },
          projectIconsByGitRemote: {
            "github.com/example/other": "/icons/other.svg",
          },
        },
        {
          workspaceRoot: "/workspace/one",
          repositoryKey: "github.com/example/one",
        },
        "git-remote",
        " ~/icons/one.svg ",
      ),
    ).toEqual({
      projectIcons: { "/workspace/two": "/icons/two.svg" },
      projectIconsByGitRemote: {
        "github.com/example/other": "/icons/other.svg",
        "github.com/example/one": "~/icons/one.svg",
      },
    });
  });

  it("falls back to a workspace setting when the project has no git remote", () => {
    expect(
      replaceProjectIconSetting(
        {
          projectIcons: {},
          projectIconsByGitRemote: {},
        },
        { workspaceRoot: "/workspace/one" },
        "git-remote",
        "/icons/one.svg",
      ),
    ).toEqual({
      projectIcons: { "/workspace/one": "/icons/one.svg" },
      projectIconsByGitRemote: {},
    });
  });
});
