import { describe, expect, it } from "vite-plus/test";

import {
  collapseDotSegments,
  relativePathWithinRoot,
  relativePathWithinSkill,
} from "./skillPreviewPaths";

describe("collapseDotSegments", () => {
  it("collapses parent segments in absolute posix paths", () => {
    expect(collapseDotSegments("/skills/review/../src/main.ts")).toBe("/skills/src/main.ts");
    expect(collapseDotSegments("/skills/review/./SKILL.md")).toBe("/skills/review/SKILL.md");
  });
});

describe("relativePathWithinSkill", () => {
  it("keeps files inside the skill after collapsing parent segments", () => {
    expect(relativePathWithinSkill("/skills/review/SKILL.md", "/skills/review/refs/note.md")).toBe(
      "refs/note.md",
    );
    expect(
      relativePathWithinSkill("/skills/review/SKILL.md", "/skills/review/../review/SKILL.md"),
    ).toBe("SKILL.md");
  });

  it("does not treat a parent-directory link as inside the skill", () => {
    expect(
      relativePathWithinSkill("/skills/review/SKILL.md", "/skills/review/../src/index.ts"),
    ).toBeNull();
  });
});

describe("relativePathWithinRoot", () => {
  it("classifies a collapsed parent link as a workspace file", () => {
    expect(relativePathWithinRoot("/repo", "/skills/review/../../repo/src/index.ts")).toBe(
      "src/index.ts",
    );
  });

  it("does not treat every absolute path as in-workspace when the root is empty", () => {
    expect(relativePathWithinRoot("", "/tmp/secret.ts")).toBeNull();
  });

  it("treats a Windows drive root as case-insensitive", () => {
    expect(relativePathWithinRoot("C:\\", "c:\\foo.md")).toBe("foo.md");
  });

  it("keeps the POSIX root as a valid workspace root", () => {
    expect(relativePathWithinRoot("/", "/tmp/secret.ts")).toBe("tmp/secret.ts");
  });
});
