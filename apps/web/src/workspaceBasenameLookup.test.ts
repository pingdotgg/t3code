import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  pickProjectLinkMatch,
  pickWorkspaceBasenameMatch,
  pickWorkspaceLinkMatch,
  threadCommandDirectories,
  workspaceLinkLookupQuery,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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

  it("opens nothing when several projects have the file", () => {
    expect(
      pickProjectLinkMatch("rules/categories.ts", [appB, { ...appB, root: "/home/user/app-c" }]),
    ).toBeNull();
  });

  it("counts one file reached through two roots once", () => {
    expect(
      pickProjectLinkMatch("rules/categories.ts", [appB, { ...appB, root: "/home/user/app-b/" }]),
    ).toBe("/home/user/app-b/src/api/rules/categories.ts");
  });
});

describe("threadCommandDirectories", () => {
  const command = (ordinal: number, input: string): OrchestrationV2TurnItem => ({
    id: TurnItemId.make(`command-${ordinal}`),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-12T00:00:00.000Z"),
    type: "command_execution",
    input,
  });

  // regression: #35337 a checkout outside every project, known only from the agent's `cd`
  it("returns absolute directories the commands changed into outside the workspace", () => {
    expect(
      threadCommandDirectories(
        [
          command(0, "cd /work/repo-b-feature && git status"),
          command(1, `/bin/bash -lc 'cd "/work/with space/" && ls'`),
          command(2, "cd /work/repo-b-feature; ls"),
          command(3, "cd ../sibling && ls"),
          command(4, "cd / && cd /home/user && ls"),
          command(5, "cd /home/user/acme/packages/web && ls"),
          command(6, "abcd /not/a/cd"),
          command(7, "printf '%s\\n' 'cd /work/repo-c'"),
          command(8, "echo hi && cd /work/later"),
          command(9, "cd /work/piped | cat"),
        ],
        "/home/user/acme",
      ),
    ).toEqual(["/work/repo-b-feature", "/work/with space"]);
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
