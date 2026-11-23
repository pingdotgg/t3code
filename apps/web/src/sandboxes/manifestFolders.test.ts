import type { AgentctlRepositoryStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullToast, repositoryBadges, tildePath } from "./manifestFolders";

const status = (overrides: Partial<AgentctlRepositoryStatus>): AgentctlRepositoryStatus => ({
  path: "/home/me/code/app",
  branch: "main",
  upstream: "origin/main",
  changes: 0,
  ahead: 0,
  behind: 0,
  fetchError: null,
  ...overrides,
});

describe("tildePath", () => {
  it("abbreviates the home directory and drops trailing separators", () => {
    expect(tildePath("/home/me/code/app/", "/home/me")).toBe("~/code/app");
    expect(tildePath("/home/me", "/home/me/")).toBe("~");
    expect(tildePath("C:\\Users\\me\\code", "C:\\Users\\me")).toBe("~\\code");
  });

  it("leaves paths outside the home directory alone", () => {
    expect(tildePath("/home/meadow/code", "/home/me")).toBe("/home/meadow/code");
    expect(tildePath("/srv/agents", "/home/me")).toBe("/srv/agents");
    expect(tildePath("/srv/agents", "")).toBe("/srv/agents");
  });
});

describe("repositoryBadges", () => {
  const labels = (overrides: Partial<AgentctlRepositoryStatus>) =>
    repositoryBadges(status(overrides)).map((badge) => badge.label);

  it("calls a clean, current checkout up to date", () => {
    expect(labels({})).toEqual(["Up to date"]);
  });

  it("shows what a pull would bring and what could block it", () => {
    expect(labels({ behind: 3, changes: 2 })).toEqual(["3 behind", "2 changes"]);
    expect(repositoryBadges(status({ behind: 1, ahead: 1 }))[1]).toMatchObject({
      label: "1 ahead",
      tone: "warning",
    });
  });

  it("does not claim a checkout is current when it cannot tell", () => {
    expect(labels({ upstream: null })).toEqual(["No upstream"]);
    expect(labels({ branch: null, upstream: null })).toEqual(["Detached"]);
    expect(labels({ fetchError: "Could not resolve host" })).toEqual(["Fetch failed"]);
    // A deleted upstream or an unborn HEAD leaves nothing to compare.
    expect(labels({ ahead: null, behind: null })).toEqual(["Upstream missing"]);
  });
});

describe("pullToast", () => {
  it("counts new commits across repositories", () => {
    expect(
      pullToast({
        error: null,
        repositories: [
          { repository: "/r/app", outcome: "updated", commits: 3, error: null },
          { repository: "/r/agents", outcome: "updated", commits: 1, error: null },
          { repository: "/r/other", outcome: "up-to-date", commits: 0, error: null },
        ],
      }),
    ).toEqual({
      type: "success",
      title: "Pulled 4 new commits",
      description: "app: 3 new commits · agents: 1 new commit",
    });
  });

  it("says when nothing changed", () => {
    expect(
      pullToast({
        error: null,
        repositories: [{ repository: "/r/app", outcome: "up-to-date", commits: 0, error: null }],
      }).title,
    ).toBe("Already up to date");
  });

  it("names each failure with git's reason", () => {
    expect(
      pullToast({
        error: null,
        repositories: [
          {
            repository: "/r/app",
            outcome: "failed",
            commits: 0,
            error: "Not possible to fast-forward, aborting.",
          },
          { repository: "/r/agents", outcome: "updated", commits: 2, error: null },
        ],
      }),
    ).toEqual({
      type: "error",
      title: "Could not pull 1 of 2 repositories",
      description: "app: Not possible to fast-forward, aborting. · agents: 2 new commits",
    });
  });
});
