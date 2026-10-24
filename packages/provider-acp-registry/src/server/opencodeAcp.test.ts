import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverOpenCodeAcpSkills } from "./opencodeAcp.ts";

const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-acp-" }),
  );
  const write = (relative: string, contents: string) =>
    fileSystem
      .makeDirectory(path.dirname(path.join(root, relative)), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(path.join(root, relative), contents)));
  const skill = (description: string) => `---\ndescription: ${description}\n---\n\nBody.\n`;
  const environment = {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    OPENCODE_CONFIG_DIR: path.join(root, "custom-config"),
  };
  // Ancestors of the temp directory and the host's system config directory
  // are real OpenCode roots too, so only this fixture's skills are compared.
  const discover = (cwd: string, overrides: NodeJS.ProcessEnv = {}) =>
    discoverOpenCodeAcpSkills(path.join(root, cwd), { ...environment, ...overrides }).pipe(
      Effect.map((skills) => skills.filter((skill) => skill.path.startsWith(root))),
    );
  const descriptions = (cwd: string, overrides: NodeJS.ProcessEnv = {}) =>
    discover(cwd, overrides).pipe(
      Effect.map((skills) =>
        Object.fromEntries(skills.map((skill) => [skill.name, skill.description ?? null])),
      ),
    );
  return { root, write, skill, discover, descriptions };
});

it.layer(NodeServices.layer)("discoverOpenCodeAcpSkills", (it) => {
  it.effect("resolves skill roots and duplicates the way OpenCode 2.1 does", () =>
    Effect.gen(function* () {
      const { write, skill, descriptions } = yield* makeFixture;
      // Every .claude root loads before any .agents root, config directories
      // override both, and nearer project directories override ancestors.
      yield* write("home/.claude/skills/shared/SKILL.md", skill("global claude"));
      yield* write("home/.agents/skills/shared/SKILL.md", skill("global agents"));
      yield* write("project/.claude/skills/compat/SKILL.md", skill("project claude"));
      yield* write("home/.agents/skills/compat/SKILL.md", skill("global agents"));
      yield* write("project/.claude/skills/claude-only/SKILL.md", skill("project claude"));
      yield* write("custom-config/skills/shared/SKILL.md", skill("custom config"));
      yield* write(
        "xdg/opencode/skills/xdg-only/SKILL.md",
        skill("replaced by OPENCODE_CONFIG_DIR"),
      );
      yield* write("project/.opencode/skill/nested/SKILL.md", skill("singular"));
      yield* write("project/.opencode/skills/nested/SKILL.md", skill("plural"));
      yield* write("project/app/.opencode/skills/nested/SKILL.md", skill("nearest"));
      yield* write("project/.opencode/skills/flat.md", skill("flat file"));
      yield* write("project/.opencode/skills/flat/SKILL.md", skill("skill directory"));
      yield* write("project/.agents/skills/venv/hidden/SKILL.md", skill("ignored"));
      yield* write("project/.agents/skills/__pycache__/hidden/SKILL.md", skill("ignored"));
      yield* write("project/.agents/skills/plain/SKILL.md", skill("plain"));

      expect(yield* descriptions("project/app")).toEqual({
        "claude-only": "project claude",
        compat: "global agents",
        flat: "skill directory",
        nested: "nearest",
        plain: "plain",
        shared: "custom config",
      });
      expect(
        yield* descriptions("project/app", {
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
        }),
      ).toEqual({ compat: "global agents", shared: "custom config" });
    }).pipe(Effect.scoped),
  );

  it.effect("skips skills OpenCode rejects and bounds frontmatter parsing", () =>
    Effect.gen(function* () {
      const { write, discover } = yield* makeFixture;
      const skills = "project/.agents/skills";
      yield* write(`${skills}/no-frontmatter/SKILL.md`, "Just instructions.\n");
      yield* write(
        `${skills}/colon/SKILL.md`,
        "---\nname: Colon Helper\ndescription: Use when: you need colons\n---\n",
      );
      yield* write(`${skills}/malformed/SKILL.md`, "---\ndescription: [unclosed\n---\n");
      yield* write(`${skills}/numeric-name/SKILL.md`, "---\nname: 3\n---\n");
      yield* write(`${skills}/numeric-description/SKILL.md`, "---\ndescription: 3\n---\n");
      // gray-matter reads an unclosed block through the end of the file.
      yield* write(`${skills}/unterminated/SKILL.md`, "---\ndescription: never closed\n");
      yield* write(`${skills}/opener-only/SKILL.md`, "---");
      yield* write(`${skills}/opener-language/SKILL.md`, "--- yaml");
      // `yaml` parses a 200KB mapping in seconds, so it is listed unparsed.
      const keys = Array.from({ length: 20_000 }, (_, index) => `key${index}: value`).join("\n");
      yield* write(`${skills}/huge/SKILL.md`, `---\ndescription: huge\n${keys}\n---\n`);

      const discovered = yield* discover("project");
      expect(
        discovered.map(({ name, displayName, description }) => ({
          name,
          displayName,
          description,
        })),
      ).toEqual([
        { name: "colon", displayName: "Colon Helper", description: "Use when: you need colons" },
        { name: "huge", displayName: undefined, description: undefined },
        { name: "no-frontmatter", displayName: undefined, description: undefined },
        { name: "opener-only", displayName: undefined, description: undefined },
        { name: "unterminated", displayName: undefined, description: "never closed" },
      ]);
    }).pipe(Effect.scoped),
  );
});
