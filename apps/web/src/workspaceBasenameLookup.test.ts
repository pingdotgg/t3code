import { describe, expect, it } from "vite-plus/test";

import { pickWorkspaceBasenameMatch } from "./workspaceBasenameLookup";

describe("pickWorkspaceBasenameMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(
      pickWorkspaceBasenameMatch("ChatView.tsx", [
        ...entries,
        { path: "ChatView.tsx", kind: "file" },
        { path: "apps/desktop/src/ChatView.tsx", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/ChatView.tsx");
  });

  it("ignores directories", () => {
    expect(
      pickWorkspaceBasenameMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
        { path: "apps/web/src/components/components", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/components");
  });

  it("prefers exact casing, otherwise requires a unique case-insensitive match", () => {
    expect(
      pickWorkspaceBasenameMatch("foo.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBe("src/foo.ts");
    expect(pickWorkspaceBasenameMatch("chatview.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBeNull();
  });

  it("returns null when nothing matches the name", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", [])).toBeNull();
    expect(
      pickWorkspaceBasenameMatch("ChatView.tsx", [
        { path: "apps/web/src/components/ChatHeader.tsx", kind: "file" },
      ]),
    ).toBeNull();
  });
});
