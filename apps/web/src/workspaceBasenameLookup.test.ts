import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  needsWorkspaceBasenameLookup,
  pickStrippedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
  stripRepeatedWorkspacePrefix,
} from "./workspaceBasenameLookup";

describe("needsWorkspaceBasenameLookup", () => {
  it("flags bare filenames", () => {
    expect(needsWorkspaceBasenameLookup("ChatView.tsx")).toBe(true);
    expect(needsWorkspaceBasenameLookup("Makefile")).toBe(true);
  });

  it("leaves anything with a directory alone", () => {
    expect(needsWorkspaceBasenameLookup("apps/web/src/components/ChatView.tsx")).toBe(false);
    expect(needsWorkspaceBasenameLookup("apps\\web\\ChatView.tsx")).toBe(false);
    expect(needsWorkspaceBasenameLookup(".")).toBe(false);
    expect(needsWorkspaceBasenameLookup("..")).toBe(false);
    expect(needsWorkspaceBasenameLookup("   ")).toBe(false);
  });
});

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

  it("returns null when nothing matches the name", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", [])).toBeNull();
    expect(
      pickWorkspaceBasenameMatch("ChatView.tsx", [
        { path: "apps/web/src/components/ChatHeader.tsx", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    // The older lookup answering last must not reopen the panel behind the
    // newer one.
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it("stays valid while it is the only claim", () => {
    const only = claimWorkspaceBasenameLookup();
    expect(only()).toBe(true);
  });
});

describe("stripRepeatedWorkspacePrefix", () => {
  it("drops the project folder repeated by a repo-root-relative path", () => {
    expect(stripRepeatedWorkspacePrefix("physics/notes/outline.md", "/school/physics")).toBe(
      "notes/outline.md",
    );
    expect(stripRepeatedWorkspacePrefix("courses/physics/a.md", "/school/courses/physics")).toBe(
      "a.md",
    );
    expect(stripRepeatedWorkspacePrefix("physics\\a.md", "C:\\school\\physics")).toBe("a.md");
    expect(stripRepeatedWorkspacePrefix("physics\\a.md", "C:\\school\\Physics")).toBe("a.md");
    expect(stripRepeatedWorkspacePrefix("physics/a.md", "/school/Physics")).toBeNull();
  });

  it("returns null when the path does not start with the project folder", () => {
    expect(stripRepeatedWorkspacePrefix("notes/outline.md", "/school/physics")).toBeNull();
    expect(stripRepeatedWorkspacePrefix("physics", "/school/physics")).toBeNull();
  });
});

describe("pickStrippedWorkspaceMatch", () => {
  const file = (path: string) => ({ path, kind: "file" as const });

  it("opens the stripped path when only it exists", () => {
    expect(
      pickStrippedWorkspaceMatch("physics/notes/a.md", "notes/a.md", "/school/physics", [
        file("notes/a.md"),
      ]),
    ).toBe("notes/a.md");
  });

  it("keeps the literal path when a real nested folder exists", () => {
    expect(
      pickStrippedWorkspaceMatch("physics/notes/a.md", "notes/a.md", "/school/physics", [
        file("notes/a.md"),
        file("physics/notes/a.md"),
      ]),
    ).toBeNull();
  });

  it("matches casing loosely only on Windows", () => {
    const entries = [file("Notes/a.md")];
    expect(
      pickStrippedWorkspaceMatch(
        "physics\\notes\\a.md",
        "notes/a.md",
        "C:\\school\\physics",
        entries,
      ),
    ).toBe("Notes/a.md");
    expect(
      pickStrippedWorkspaceMatch("physics/notes/a.md", "notes/a.md", "/school/physics", entries),
    ).toBeNull();
  });
});
