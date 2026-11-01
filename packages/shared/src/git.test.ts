import { SourceControlProviderKind } from "@t3tools/contracts";
import type { VcsStatusRemoteResult, VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitStatusStreamEvent,
  formatGeneratedBranchName,
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseOriginUrlFromGitConfig,
  resolveAutoFeatureBranchName,
  sanitizeFeatureBranchName,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:T3Tools/T3Code.git")).toBe(
      "github.com/t3tools/t3code",
    );
    expect(normalizeGitRemoteUrl("https://github.com/T3Tools/T3Code.git")).toBe(
      "github.com/t3tools/t3code",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/T3Tools/T3Code")).toBe(
      "github.com/t3tools/t3code",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:T3Tools/platform/T3Code.git")).toBe(
      "gitlab.com/t3tools/platform/t3code",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/T3Tools/platform/T3Code.git")).toBe(
      "gitlab.com/t3tools/platform/t3code",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });

  it("normalizes SCP-like remotes with non-git SSH users", () => {
    expect(normalizeGitRemoteUrl("gitlab@gitlab.example.com:group/project.git")).toBe(
      "gitlab.example.com/group/project",
    );
    expect(normalizeGitRemoteUrl("deploy@bitbucket.org:workspace/repo.git")).toBe(
      "bitbucket.org/workspace/repo",
    );
    expect(normalizeGitRemoteUrl("code.example.test:team/repo.git")).toBe(
      "code.example.test/team/repo",
    );
    expect(normalizeGitRemoteUrl("git@code.example.test:/team/repo.git")).toBe(
      "code.example.test/team/repo",
    );
    expect(normalizeGitRemoteUrl("C:/repos/project")).toBe("c:/repos/project");
    expect(normalizeGitRemoteUrl("git@x:team/project.git")).toBe("x/team/project");
  });
});

describe("parseOriginUrlFromGitConfig", () => {
  it("reads the origin url and ignores other remotes", () => {
    const config = [
      "[core]",
      "\trepositoryformatversion = 0",
      '[remote "upstream"]',
      "\turl = https://github.com/other/repo.git",
      '[remote "origin"]',
      "\turl = git@github.com:pingdotgg/t3code.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[branch "main"]',
      "\tremote = origin",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(config)).toBe("git@github.com:pingdotgg/t3code.git");
  });

  it("strips inline comments and quotes from the url value", () => {
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "origin"]\n\turl = https://github.com/acme/repo.git # mirror\n',
      ),
    ).toBe("https://github.com/acme/repo.git");
    expect(
      parseOriginUrlFromGitConfig('[remote "origin"]\n\turl = "git@github.com:acme/repo.git"\n'),
    ).toBe("git@github.com:acme/repo.git");
  });

  it("accepts legacy dotted headers, header comments, and line continuations", () => {
    expect(parseOriginUrlFromGitConfig("[remote.origin]\n\turl = git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    expect(parseOriginUrlFromGitConfig("[remote.Origin]\n\turl = git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "Origin"]\n\turl = git@github.com:x/y.git\n[remote "origin"]\n\turl = git@github.com:a/b.git\n',
      ),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseOriginUrlFromGitConfig('[remote "origin"] # primary\n\turl = git@github.com:a/b.git\n'),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "origin"]\n\turl = https://github.com/acme/\\\n\t\trepo.git\n',
      ),
    ).toBe("https://github.com/acme/repo.git");
  });

  it("reads settings on the remote header line", () => {
    const upstream = '\n[remote "upstream"]\n\turl = https://github.com/other/source.git\n';
    expect(
      parseOriginUrlFromGitConfig(`[remote "origin"] url = git@github.com:a/b.git${upstream}`),
    ).toBe("git@github.com:a/b.git");
    expect(parseOriginUrlFromGitConfig("[remote.Origin]url=git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    expect(
      parseOriginUrlFromGitConfig(
        `[remote "origin"] fetch = +refs/heads/*:refs/remotes/origin/*\n\turl = git@github.com:a/b.git${upstream}`,
      ),
    ).toBe("git@github.com:a/b.git");
  });

  it("falls back to the first remote when there is no origin", () => {
    const config = [
      '[remote "upstream"]',
      "\turl = https://github.com/acme/repo.git",
      '[remote "fork"]',
      "\turl = https://github.com/me/repo.git",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(config)).toBe("https://github.com/acme/repo.git");
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("normalizes a UUID-shaped random callback to the canonical 8-hex form", () => {
    expect(buildTemporaryWorktreeBranchName(() => "f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(
      `${WORKTREE_BRANCH_PREFIX}/f4ae4e0e`,
    );
  });

  it("matches legacy t3code temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch("t3code/deadbeef")).toBe(true);
    expect(isTemporaryWorktreeBranch("t3code-deadbeef")).toBe(true);
    expect(isTemporaryWorktreeBranch("t3code/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(true);
    expect(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12`),
    ).toBe(false);
  });

  it("rejects UUID-shaped refs that are not RFC 4122 v4", () => {
    expect(isTemporaryWorktreeBranch("t3code/f4ae4e0e-f971-1d48-b4f2-9cf0aa54ab12")).toBe(false);
    expect(isTemporaryWorktreeBranch("t3code/f4ae4e0e-f971-4d48-c4f2-9cf0aa54ab12")).toBe(false);
  });

  it("matches the flat fallback used when a plain t3 branch exists", () => {
    const flat = flattenTemporaryWorktreeBranchName(`${WORKTREE_BRANCH_PREFIX}/deadbeef`);
    expect(flat).toBe(`${WORKTREE_BRANCH_PREFIX}-deadbeef`);
    expect(isTemporaryWorktreeBranch(flat)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}-deadbeef-extra`)).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}-feature`)).toBe(false);
    expect(flattenTemporaryWorktreeBranchName("t3code/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(
      `${WORKTREE_BRANCH_PREFIX}-f4ae4e0e`,
    );
    expect(flattenTemporaryWorktreeBranchName("t3code-deadbeef")).toBe(
      `${WORKTREE_BRANCH_PREFIX}-deadbeef`,
    );
    expect(flattenTemporaryWorktreeBranchName("t3code/deadbeef")).toBe(
      `${WORKTREE_BRANCH_PREFIX}-deadbeef`,
    );
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: SourceControlProviderKind.make("github"),
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});

describe("sanitizeFeatureBranchName", () => {
  it("sanitizes an explicit namespace before preserving it", () => {
    expect(sanitizeFeatureBranchName(' "FIX//Calendar recruitment filter" ')).toBe(
      "fix/calendar-recruitment-filter",
    );
  });

  // regression: #15615 generated branch namespaces are preserved
  it.each([
    ["refine toolbar", "feature/refine-toolbar"],
    [" /?. / ", "feature/update"],
    ["fix///", "feature/fix"],
  ])("keeps the fallback for unprefixed input %s", (input, expected) => {
    expect(sanitizeFeatureBranchName(input)).toBe(expected);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("resolves case-insensitive collisions within the generated namespace", () => {
    expect(
      resolveAutoFeatureBranchName(
        ["FIX/refine-toolbar", "fix/refine-toolbar-2"],
        "fix/refine-toolbar",
      ),
    ).toBe("fix/refine-toolbar-3");
  });

  // regression: #15615 generated branch namespaces are preserved
  it.each([
    ["fix/name", ["fix"], "fix-2/name"],
    ["fix/name", ["fix/name/child"], "fix/name-2"],
    ["fix/name", ["fixes", "fix/name-extra/child"], "fix/name"],
  ])("resolves %s against namespace blockers %j", (preferredBranch, existingNames, expected) => {
    expect(resolveAutoFeatureBranchName(existingNames, preferredBranch)).toBe(expected);
  });
});

describe("formatGeneratedBranchName", () => {
  it.each([
    [" Team / Jules.lock/", "Team/Jules-lock/add-search"],
    ["-team//feature@{new}", "team/feature-new/add-search"],
    [" /?. / ", "add-search"],
  ])("normalizes invalid static prefix %s", (prefix, expected) => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix, instructions: "" }),
    ).toBe(expected);
  });
  it("uses the model's semantic prefix without the stored static prefix", () => {
    expect(
      formatGeneratedBranchName("feat/Add Search", {
        mode: "semantic",
        prefix: "t3code",
        instructions: "",
      }),
    ).toBe("feat/add-search");
  });
});
