// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  applyCursorSkillMentions,
  collectCursorSkillMentions,
  discoverCursorSkillsWithFs,
  parseCursorSkillMarkdown,
  resolveCursorSkillRoots,
  toServerProviderSkills,
} from "./cursorSkillDiscovery.ts";

describe("resolveCursorSkillRoots", () => {
  it("resolves project and user Cursor skill directories", () => {
    expect(
      resolveCursorSkillRoots({
        projectCwd: "/tmp/project",
        userHome: "/Users/demo",
      }),
    ).toEqual({
      projectSkillsDirs: [NodePath.join(NodePath.resolve("/tmp/project"), ".cursor", "skills")],
      userSkillsDir: NodePath.join("/Users/demo", ".cursor", "skills"),
    });
  });

  it("omits project root when cwd is missing", () => {
    expect(resolveCursorSkillRoots({ projectCwd: null, userHome: "/Users/demo" })).toEqual({
      projectSkillsDirs: [],
      userSkillsDir: NodePath.join("/Users/demo", ".cursor", "skills"),
    });
  });

  it("scopes project skills to the provided workspace cwd", () => {
    expect(
      resolveCursorSkillRoots({
        projectCwd: "/workspace/active-project",
        userHome: "/Users/demo",
      }),
    ).toEqual({
      projectSkillsDirs: [
        NodePath.join(NodePath.resolve("/workspace/active-project"), ".cursor", "skills"),
      ],
      userSkillsDir: NodePath.join("/Users/demo", ".cursor", "skills"),
    });
  });

  it("merges additional project cwds and dedupes resolved paths", () => {
    const sessionCwd = "/tmp/worktree";
    const listingCwd = "/tmp/workspace";
    expect(
      resolveCursorSkillRoots({
        projectCwd: sessionCwd,
        additionalProjectCwds: [listingCwd, `${sessionCwd}/`],
        userHome: "/Users/demo",
      }),
    ).toEqual({
      projectSkillsDirs: [
        NodePath.join(NodePath.resolve(sessionCwd), ".cursor", "skills"),
        NodePath.join(NodePath.resolve(listingCwd), ".cursor", "skills"),
      ],
      userSkillsDir: NodePath.join("/Users/demo", ".cursor", "skills"),
    });
  });
});

describe("parseCursorSkillMarkdown", () => {
  it("parses name and folded description from frontmatter", () => {
    const skill = parseCursorSkillMarkdown(
      `---
name: demo-skill
description: >-
  Helps with demos when the user asks.
disable-model-invocation: true
---

# Demo

Do the demo.
`,
      "/tmp/project/.cursor/skills/demo-skill/SKILL.md",
      "demo-skill",
      "repo",
    );

    expect(skill).toMatchObject({
      name: "demo-skill",
      description: "Helps with demos when the user asks.",
      scope: "repo",
      enabled: true,
      path: "/tmp/project/.cursor/skills/demo-skill/SKILL.md",
    });
    expect(skill?.content).toContain("# Demo");
  });

  it("falls back to directory name when frontmatter name is missing", () => {
    const skill = parseCursorSkillMarkdown(
      `---
description: A simple skill
---

Body
`,
      "/tmp/x/.cursor/skills/my-skill/SKILL.md",
      "my-skill",
      "user",
    );
    expect(skill?.name).toBe("my-skill");
    expect(skill?.scope).toBe("user");
  });

  it("rejects invalid skill names", () => {
    expect(
      parseCursorSkillMarkdown(
        `---
name: Bad_Name
---
`,
        "/tmp/x/.cursor/skills/Bad_Name/SKILL.md",
        "Bad_Name",
      ),
    ).toBeNull();
  });
});

describe("discoverCursorSkillsWithFs", () => {
  it("discovers project and user skills, preferring project on name collision", async () => {
    const files = new Map<string, string>([
      [
        "/proj/.cursor/skills/shared/SKILL.md",
        `---
name: shared
description: Project shared skill
---
# Project shared
`,
      ],
      [
        "/proj/.cursor/skills/local-only/SKILL.md",
        `---
name: local-only
description: Only in project
---
# Local
`,
      ],
      [
        "/home/.cursor/skills/shared/SKILL.md",
        `---
name: shared
description: User shared skill
---
# User shared
`,
      ],
      [
        "/home/.cursor/skills/user-only/SKILL.md",
        `---
name: user-only
description: Only for user
---
# User
`,
      ],
    ]);
    const directories = new Set([
      "/proj/.cursor/skills",
      "/proj/.cursor/skills/shared",
      "/proj/.cursor/skills/local-only",
      "/home/.cursor/skills",
      "/home/.cursor/skills/shared",
      "/home/.cursor/skills/user-only",
    ]);

    const skills = await discoverCursorSkillsWithFs(
      {
        projectSkillsDirs: ["/proj/.cursor/skills"],
        userSkillsDir: "/home/.cursor/skills",
      },
      {
        readFile: async (path) => files.get(path) ?? null,
        readDirectory: async (path) => {
          if (path === "/proj/.cursor/skills") {
            return ["shared", "local-only"];
          }
          if (path === "/home/.cursor/skills") {
            return ["shared", "user-only"];
          }
          return null;
        },
        isDirectory: async (path) => directories.has(path),
        join: (...parts) => parts.join("/"),
      },
    );

    expect(skills.map((skill) => skill.name).sort()).toEqual(["local-only", "shared", "user-only"]);
    expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
      scope: "repo",
      description: "Project shared skill",
    });
    expect(toServerProviderSkills(skills).every((skill) => !("content" in skill))).toBe(true);
  });

  it("merges skills from multiple project roots with earlier roots winning", async () => {
    const files = new Map<string, string>([
      [
        "/session/.cursor/skills/session-only/SKILL.md",
        `---
name: session-only
description: Only in session cwd
---
# Session
`,
      ],
      [
        "/session/.cursor/skills/shared/SKILL.md",
        `---
name: shared
description: Session shared skill
---
# Session shared
`,
      ],
      [
        "/listing/.cursor/skills/shared/SKILL.md",
        `---
name: shared
description: Listing shared skill
---
# Listing shared
`,
      ],
      [
        "/listing/.cursor/skills/listed-only/SKILL.md",
        `---
name: listed-only
description: Only in listing cwd
---
# Listed
`,
      ],
    ]);
    const directories = new Set([
      "/session/.cursor/skills",
      "/session/.cursor/skills/session-only",
      "/session/.cursor/skills/shared",
      "/listing/.cursor/skills",
      "/listing/.cursor/skills/shared",
      "/listing/.cursor/skills/listed-only",
    ]);

    const skills = await discoverCursorSkillsWithFs(
      {
        projectSkillsDirs: ["/session/.cursor/skills", "/listing/.cursor/skills"],
        userSkillsDir: null,
      },
      {
        readFile: async (path) => files.get(path) ?? null,
        readDirectory: async (path) => {
          if (path === "/session/.cursor/skills") {
            return ["session-only", "shared"];
          }
          if (path === "/listing/.cursor/skills") {
            return ["shared", "listed-only"];
          }
          return null;
        },
        isDirectory: async (path) => directories.has(path),
        join: (...parts) => parts.join("/"),
      },
    );

    expect(skills.map((skill) => skill.name).sort()).toEqual([
      "listed-only",
      "session-only",
      "shared",
    ]);
    expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
      description: "Session shared skill",
      path: "/session/.cursor/skills/shared/SKILL.md",
    });
    expect(skills.find((skill) => skill.name === "listed-only")).toMatchObject({
      path: "/listing/.cursor/skills/listed-only/SKILL.md",
    });
  });

  it("soft-fails missing skill roots", async () => {
    const skills = await discoverCursorSkillsWithFs(
      {
        projectSkillsDirs: ["/missing/.cursor/skills"],
        userSkillsDir: null,
      },
      {
        readFile: async () => null,
        readDirectory: async () => null,
        isDirectory: async () => false,
        join: (...parts) => parts.join("/"),
      },
    );
    expect(skills).toEqual([]);
  });

  it("discovers real temp directories on disk", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-skills-"));
    const projectSkills = NodePath.join(root, "project", ".cursor", "skills", "ship-it");
    await NodeFS.mkdir(projectSkills, { recursive: true });
    await NodeFS.writeFile(
      NodePath.join(projectSkills, "SKILL.md"),
      `---
name: ship-it
description: Ships the thing
---

# Ship it
`,
      "utf8",
    );

    const skills = await discoverCursorSkillsWithFs(
      {
        projectSkillsDir: NodePath.join(root, "project", ".cursor", "skills"),
        userSkillsDir: NodePath.join(root, "nouser", ".cursor", "skills"),
      },
      {
        readFile: async (path) => {
          try {
            return await NodeFS.readFile(path, "utf8");
          } catch {
            return null;
          }
        },
        readDirectory: async (path) => {
          try {
            return await NodeFS.readdir(path);
          } catch {
            return null;
          }
        },
        isDirectory: async (path) => {
          try {
            const stat = await NodeFS.stat(path);
            return stat.isDirectory();
          } catch {
            return false;
          }
        },
        join: NodePath.join,
      },
    );

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "ship-it",
      scope: "repo",
      enabled: true,
    });
  });
});

describe("applyCursorSkillMentions", () => {
  it("collects unique $skill mentions", () => {
    expect(collectCursorSkillMentions("$ship-it please and $ship-it again $unknown")).toEqual([
      "ship-it",
      "unknown",
    ]);
  });

  it("injects SKILL.md bodies for matched mentions and strips $tokens", () => {
    const applied = applyCursorSkillMentions("$ship-it do the thing", [
      {
        name: "ship-it",
        enabled: true,
        content: `---
name: ship-it
---

# Ship it instructions
`,
      },
    ]);

    expect(applied).toContain("Skill `ship-it` (applied by T3 Code for Cursor ACP):");
    expect(applied).toContain("# Ship it instructions");
    expect(applied).toContain("do the thing");
    expect(applied).not.toMatch(/\$ship-it\b/);
  });

  it("leaves unknown $mentions unchanged", () => {
    expect(applyCursorSkillMentions("$missing please", [])).toBe("$missing please");
  });

  it("skips disabled skills", () => {
    expect(
      applyCursorSkillMentions("$off please", [{ name: "off", enabled: false, content: "# Off" }]),
    ).toBe("$off please");
  });
});
