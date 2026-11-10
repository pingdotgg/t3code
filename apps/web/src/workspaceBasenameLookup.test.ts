import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
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

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });
});
