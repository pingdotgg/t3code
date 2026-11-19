import { describe, expect, it } from "vite-plus/test";

import {
  agentWorkingDirectories,
  claimWorkspaceBasenameLookup,
  findAgentDirectoryMatch,
  pickProjectLinkMatch as pickProjectLinkMatchWithCanonicalPaths,
  pickWorkspaceBasenameMatch,
  pickWorkspaceLinkMatch,
  workspaceLinkLookupQuery,
} from "@t3tools/client-runtime/workspace-basename-lookup";

describe("pickWorkspaceBasenameMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  // regression: #6297 a bare filename resolves to a file, never a same-named directory
  it("ignores directories", () => {
    expect(
      pickWorkspaceBasenameMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
        { path: "apps/web/src/components/components", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/components");
  });

  it("prefers the exactly-cased file over a case-only twin", () => {
    expect(
      pickWorkspaceBasenameMatch("foo.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBe("src/foo.ts");
  });

  it("falls back to case-insensitive when only the casing differs", () => {
    expect(pickWorkspaceBasenameMatch("chatview.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("returns null when the case-insensitive fallback is ambiguous", () => {
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("chat file links an agent shortened", () => {
  const cwd = "/home/user/acme";
  const entries = [
    { path: "packages/server/src/cloud/http.ts", kind: "file" as const },
    { path: "packages/server/src/cloud", kind: "directory" as const },
    { path: "packages/web/src/api/http.ts", kind: "file" as const },
    { path: "packages/server/src/index.ts", kind: "file" as const },
    { path: "packages/web/src/index.ts", kind: "file" as const },
  ];

  it("searches for package-relative paths and repeated prefixes, not exact ones", () => {
    expect(workspaceLinkLookupQuery("cloud/http.ts", cwd)).toBe("cloud/http.ts");
    expect(workspaceLinkLookupQuery("acme/packages/web/src/index.ts", cwd)).toBe(
      "packages/web/src/index.ts",
    );
    expect(workspaceLinkLookupQuery("./cloud/http.ts", cwd)).toBeNull();
    expect(workspaceLinkLookupQuery("~/acme/src/config.ts", cwd)).toBeNull();
    expect(workspaceLinkLookupQuery("packages/server/", cwd)).toBeNull();
  });

  it("opens the one file a package-relative path is the suffix of", () => {
    expect(pickWorkspaceLinkMatch("cloud/http.ts", cwd, entries)).toBe(
      "packages/server/src/cloud/http.ts",
    );
    expect(pickWorkspaceLinkMatch("acme/packages/web/src/index.ts", cwd, entries)).toBe(
      "packages/web/src/index.ts",
    );
  });

  it("opens nothing when the suffix names several files or splits a segment", () => {
    expect(pickWorkspaceLinkMatch("src/index.ts", cwd, entries)).toBeNull();
    expect(pickWorkspaceLinkMatch("ud/http.ts", cwd, entries)).toBeNull();
  });
});

describe("chat file links into another project", () => {
  const pickProjectLinkMatch = (
    relativePath: string,
    searches: Parameters<typeof pickProjectLinkMatchWithCanonicalPaths>[1],
  ) =>
    pickProjectLinkMatchWithCanonicalPaths(relativePath, searches, (paths) =>
      paths.map((path) =>
        path === "C:\\Reports\\docs\\handoff.txt" || path === "c:/reports/docs\\handoff.txt"
          ? "C:\\Reports\\docs\\handoff.txt"
          : undefined,
      ),
    );

  const appB = {
    root: "/home/user/app-b",
    entries: [{ path: "src/api/rules/categories.ts", kind: "file" as const }],
  };

  // regression: #10553 a path the agent cited inside another registered project
  it("resolves to the absolute path in the one project that has the file", () => {
    expect(
      pickProjectLinkMatch("rules/categories.ts", [
        { root: "/home/user/app-c", entries: [] },
        appB,
      ]),
    ).toBe("/home/user/app-b/src/api/rules/categories.ts");
  });

  it.each([
    {
      outer: "/home/user/reports",
      inner: "/home/user/reports/docs",
      found: "/home/user/reports/docs/handoff.txt",
    },
    { outer: "C:\\Reports", inner: "c:/reports/docs/", found: "C:\\Reports\\docs\\handoff.txt" },
  ])("resolves one file that a project nested in $outer also lists", ({ outer, inner, found }) => {
    expect(
      pickProjectLinkMatch("handoff.txt", [
        { root: outer, entries: [{ path: "docs/handoff.txt", kind: "file" }] },
        { root: inner, entries: [{ path: "handoff.txt", kind: "file" }] },
      ]),
    ).toBe(found);
  });

  it("opens nothing when several projects have the file", () => {
    expect(
      pickProjectLinkMatch("rules/categories.ts", [appB, { ...appB, root: "/home/user/app-c" }]),
    ).toBeNull();
  });

  it("keeps Windows case twins ambiguous unless the server confirms the same target", async () => {
    const searches = [
      { root: "C:\\Reports", entries: [{ path: "Docs/handoff.txt", kind: "file" as const }] },
      { root: "C:\\Reports\\docs", entries: [{ path: "handoff.txt", kind: "file" as const }] },
    ];
    expect(pickProjectLinkMatchWithCanonicalPaths("handoff.txt", searches)).toBeNull();
    const upper = "C:\\Reports\\Docs\\handoff.txt";
    const lower = "C:\\Reports\\docs\\handoff.txt";
    const resolveUsing = (canonicalPaths: ReadonlyMap<string, string>) =>
      pickProjectLinkMatchWithCanonicalPaths("handoff.txt", searches, async (paths) =>
        paths.map((path) => canonicalPaths.get(path)),
      );
    expect(
      await resolveUsing(
        new Map([
          [upper, upper],
          [lower, lower],
        ]),
      ),
    ).toBeNull();
    expect(await resolveUsing(new Map([[upper, upper]]))).toBeNull();
    expect(
      await resolveUsing(
        new Map([
          [upper, upper],
          [lower, upper],
        ]),
      ),
    ).toBe(upper);
  });
});

// regression: #35337 a path the agent cited inside a checkout no project is rooted at
describe("agentWorkingDirectories", () => {
  const directories = (...commands: ReadonlyArray<string>) =>
    agentWorkingDirectories(
      [...commands, "the reply", "cd /work/later"].map((input, index) => ({
        sourceThreadId: "thread",
        sourceItemId: `item-${index}`,
        item: { type: "command_execution", input },
      })),
      { sourceThreadId: "thread", sourceItemId: `item-${commands.length}` },
    );

  it("lists the folders commands above the reply changed into, the latest first", () => {
    expect(
      directories(
        "cd /work/repo-c && cd /work/repo-b && git diff",
        "git status",
        `/bin/zsh -lc "cd '/work/my repo'; ls"`,
        "cd -P /work/repo-a # not this; cd /work/commented",
        "cd /work/repo-c\npwd",
      ),
    ).toEqual(["/work/repo-c", "/work/repo-a", "/work/my repo", "/work/repo-b"]);
  });

  it("skips operands only the shell can resolve and words that are not the command", () => {
    expect(
      directories(
        "cd docs && cd ../other && cd ~/repo && cd $ROOT/x && cd /work/*/src",
        "abcd /work/a; echo cd /work/b; git -C /work/c status; cd /work/d",
        `echo "cd /work/g"; echo 'x; cd /work/h' && grep -c "cd /work/i" notes`,
        "echo bash -c 'cd /work/j'; cd -",
        "cat <<EOF > notes\ncd /work/k\nEOF",
        "cd /work/e\\ f && cd `pwd`/x",
      ),
    ).toEqual(["/work/d"]);
  });
});

// regression: #35337 a bare file name the agent cited from a subfolder of an unregistered checkout
describe("findAgentDirectoryMatch", () => {
  const search = (found: Record<string, ReadonlyArray<string>>) => (root: string) =>
    Promise.resolve({
      root,
      entries: (found[root] ?? []).map((path) => ({ path, kind: "file" as const })),
    });

  it("opens the one file of that name in the latest folder the agent worked in", async () => {
    expect(
      await findAgentDirectoryMatch(
        "config.test.yaml",
        ["/work/repo-b/server", "/work/repo-b", "/work/repo-c"],
        search({
          "/work/repo-b/server": ["config.test.yaml"],
          "/work/repo-b": ["server/config.test.yaml"],
          "/work/repo-c": ["config.test.yaml"],
        }),
      ),
    ).toBe("/work/repo-b/server/config.test.yaml");
  });

  it("passes over a folder without the file, and opens nothing when none has it", async () => {
    const found = search({ "/work/repo-c": ["etc/config.test.yaml"] });
    expect(
      await findAgentDirectoryMatch("config.test.yaml", ["/work/repo-b", "/work/repo-c"], found),
    ).toBe("/work/repo-c/etc/config.test.yaml");
    expect(await findAgentDirectoryMatch("config.test.yaml", ["/work/repo-b"], found)).toBeNull();
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });
});
