// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  applyCursorSkillMentions,
  collectCursorSkillMentions,
  discoverCursorSkillsWithFs,
  MAX_CURSOR_SKILL_CONTENT_BYTES,
  parseCursorSkillMarkdown,
  resolveCursorSkillRoots,
  skillBodyForInjection,
  stripYamlFrontmatter,
  toServerProviderSkills,
  type CursorSkillDiscoveryFs,
} from "./cursorSkillDiscovery.ts";

function nodeDiscoveryFs(): CursorSkillDiscoveryFs {
  return {
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
    realPath: async (path) => {
      try {
        return await NodeFS.realpath(path);
      } catch {
        return null;
      }
    },
    lstatIsRegularFile: async (path) => {
      try {
        const stat = await NodeFS.lstat(path);
        return stat.isFile();
      } catch {
        return false;
      }
    },
  };
}

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
    expect(skill?.content).not.toContain("disable-model-invocation");
    expect(skill?.content).not.toMatch(/^---/);
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
    expect(skill?.content).toBe("Body");
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

  it("rejects skill bodies over the size cap", () => {
    const oversizedBody = "x".repeat(MAX_CURSOR_SKILL_CONTENT_BYTES + 1);
    expect(
      parseCursorSkillMarkdown(
        `---
name: huge
---

${oversizedBody}
`,
        "/tmp/x/.cursor/skills/huge/SKILL.md",
        "huge",
      ),
    ).toBeNull();
  });
});

describe("stripYamlFrontmatter / skillBodyForInjection", () => {
  it("strips YAML frontmatter for injection", () => {
    expect(
      stripYamlFrontmatter(`---
name: demo
---

# Body
`),
    ).toBe("# Body");
  });

  it("returns null for oversized injection bodies", () => {
    expect(skillBodyForInjection("x".repeat(MAX_CURSOR_SKILL_CONTENT_BYTES + 1))).toBeNull();
    expect(skillBodyForInjection("ok")).toBe("ok");
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
      nodeDiscoveryFs(),
    );

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "ship-it",
      scope: "repo",
      enabled: true,
      content: "# Ship it",
    });
  });

  it("rejects skill directories that symlink outside the skills root", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-skills-escape-dir-"));
    const skillsRoot = NodePath.join(root, "project", ".cursor", "skills");
    const outsideDir = NodePath.join(root, "outside", "leaked");
    await NodeFS.mkdir(skillsRoot, { recursive: true });
    await NodeFS.mkdir(outsideDir, { recursive: true });
    await NodeFS.writeFile(
      NodePath.join(outsideDir, "SKILL.md"),
      `---
name: leaked
---

# Outside
`,
      "utf8",
    );
    await NodeFS.symlink(outsideDir, NodePath.join(skillsRoot, "leaked"));

    const skills = await discoverCursorSkillsWithFs(
      { projectSkillsDirs: [skillsRoot], userSkillsDir: null },
      nodeDiscoveryFs(),
    );
    expect(skills).toEqual([]);
  });

  it("rejects SKILL.md files that symlink outside the skills root", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-skills-escape-file-"));
    const skillDir = NodePath.join(root, "project", ".cursor", "skills", "leaked");
    const outsideFile = NodePath.join(root, "outside", "secret.md");
    await NodeFS.mkdir(skillDir, { recursive: true });
    await NodeFS.mkdir(NodePath.dirname(outsideFile), { recursive: true });
    await NodeFS.writeFile(
      outsideFile,
      `---
name: leaked
---

# Outside secret
`,
      "utf8",
    );
    await NodeFS.symlink(outsideFile, NodePath.join(skillDir, "SKILL.md"));

    const skills = await discoverCursorSkillsWithFs(
      {
        projectSkillsDirs: [NodePath.join(root, "project", ".cursor", "skills")],
        userSkillsDir: null,
      },
      nodeDiscoveryFs(),
    );
    expect(skills).toEqual([]);
  });

  it("skips oversized skill files during discovery", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-skills-huge-"));
    const skillDir = NodePath.join(root, "project", ".cursor", "skills", "huge");
    await NodeFS.mkdir(skillDir, { recursive: true });
    await NodeFS.writeFile(
      NodePath.join(skillDir, "SKILL.md"),
      `---
name: huge
---

${"x".repeat(MAX_CURSOR_SKILL_CONTENT_BYTES + 1)}
`,
      "utf8",
    );

    const skills = await discoverCursorSkillsWithFs(
      {
        projectSkillsDirs: [NodePath.join(root, "project", ".cursor", "skills")],
        userSkillsDir: null,
      },
      nodeDiscoveryFs(),
    );
    expect(skills).toEqual([]);
  });
});

describe("applyCursorSkillMentions", () => {
  it("collects unique $skill mentions", () => {
    expect(collectCursorSkillMentions("$ship-it please and $ship-it again $unknown")).toEqual([
      "ship-it",
      "unknown",
    ]);
  });

  it("does not treat ENV=$name or mid-token $ as mentions", () => {
    expect(collectCursorSkillMentions("ENV=$ship-it and pre$ship-it mid")).toEqual([]);
    expect(collectCursorSkillMentions("foo_ship-it $ok end")).toEqual(["ok"]);
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
    expect(applied).not.toContain("name: ship-it");
    expect(applied).not.toMatch(/\$ship-it\b/);
  });

  it("leaves ENV=$name unchanged while still applying a leading $name mention", () => {
    const applied = applyCursorSkillMentions("ENV=$ship-it and $ship-it please", [
      {
        name: "ship-it",
        enabled: true,
        content: "# Body",
      },
    ]);
    expect(applied).toContain("ENV=$ship-it");
    expect(applied).toContain("# Body");
    expect(applied).toContain("please");
    // Only the ENV= form remains; the free-standing mention was stripped.
    expect(applied.match(/\$ship-it/g)).toEqual(["$ship-it"]);
  });

  it("leaves unknown $mentions unchanged", () => {
    expect(applyCursorSkillMentions("$missing please", [])).toBe("$missing please");
  });

  it("skips disabled skills", () => {
    expect(
      applyCursorSkillMentions("$off please", [{ name: "off", enabled: false, content: "# Off" }]),
    ).toBe("$off please");
  });

  it("skips oversized skills at apply time", () => {
    const oversized = "x".repeat(MAX_CURSOR_SKILL_CONTENT_BYTES + 1);
    expect(
      applyCursorSkillMentions("$huge please", [
        { name: "huge", enabled: true, content: oversized },
      ]),
    ).toBe("$huge please");
  });
});
