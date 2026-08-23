import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverGrokSkills,
  mergeGrokHarnessCatalogs,
  parseGrokAvailableCommands,
  parseGrokInspectReport,
  queryGrokInspectCatalog,
  resolveGrokPickerCatalog,
} from "./GrokSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it("parseGrokInspectReport includes bundled skills and invocable slash names", () => {
  const catalog = parseGrokInspectReport(
    {
      skills: [
        {
          name: "create-skill",
          description: "Create a skill.",
          source: { type: "bundled", path: "/bundled/create-skill/SKILL.md" },
          userInvocable: true,
        },
        {
          name: "imagine",
          description: "Generate an image.",
          source: { type: "bundled", path: "/bundled/imagine/SKILL.md" },
          userInvocable: true,
          invocableAs: "bundled:imagine",
        },
        {
          name: "local-review",
          description: "Project review skill.",
          source: { type: "project", path: "/repo/.grok/skills/local-review/SKILL.md" },
          userInvocable: true,
        },
        {
          name: "docx",
          description: "Word docs.",
          source: { type: "bundled", path: "/bundled/docx/SKILL.md" },
          userInvocable: false,
        },
      ],
    },
    "/repo",
  );

  assert.ok(
    catalog.skills.some((skill) => skill.name === "create-skill" && skill.scope === "bundled"),
  );
  assert.equal(catalog.skills.find((skill) => skill.name === "create-skill")?.sourceCwd, undefined);
  assert.equal(catalog.skills.find((skill) => skill.name === "local-review")?.sourceCwd, "/repo");
  assert.ok(catalog.skills.some((skill) => skill.name === "docx"));
  assert.ok(catalog.slashCommands.some((command) => command.name === "create-skill"));
  assert.ok(catalog.slashCommands.some((command) => command.name === "bundled:imagine"));
  assert.equal(
    catalog.slashCommands.find((command) => command.name === "local-review")?.sourceCwd,
    "/repo",
  );
  assert.ok(!catalog.slashCommands.some((command) => command.name === "docx"));
});

it("parseGrokInspectReport ignores extra inspect report fields", () => {
  const catalog = parseGrokInspectReport({
    grokVersion: "1.0.4",
    cwd: "/repo",
    skills: [
      {
        name: "review",
        description: "Review changes.",
        source: { type: "bundled", path: "/bundled/review/SKILL.md", extra: true },
        userInvocable: true,
        collidesWith: "review",
      },
    ],
  });
  assert.equal(catalog.skills[0]?.name, "review");
  assert.equal(catalog.slashCommands[0]?.name, "review");
});

it("parseGrokInspectReport preserves explicit aliases over later bare names", () => {
  const catalog = parseGrokInspectReport({
    skills: [
      {
        name: "aliased-skill",
        description: "Explicit alias owner.",
        source: { type: "bundled", path: "/bundled/aliased/SKILL.md" },
        userInvocable: true,
        invocableAs: "review",
      },
      {
        name: "review",
        description: "Bare-name fallback.",
        source: { type: "bundled", path: "/bundled/review/SKILL.md" },
        userInvocable: true,
      },
    ],
  });

  assert.deepEqual(catalog.slashCommands, [
    { name: "review", description: "Explicit alias owner." },
  ]);
});

it("parseGrokAvailableCommands splits harness features from skill commands", () => {
  const catalog = parseGrokAvailableCommands(
    [
      {
        name: "compact",
        description: "Compress conversation history",
        input: { hint: "optional context" },
      },
      {
        name: "create-skill",
        description: "Create a skill",
        _meta: {
          scope: "bundled",
          path: "/bundled/create-skill/SKILL.md",
          bareName: "create-skill",
        },
      },
      {
        name: "local:review",
        description: "Review the project",
        _meta: {
          scope: "local",
          path: "/repo/.grok/skills/review/SKILL.md",
          bareName: "review",
        },
      },
    ],
    "/repo",
  );

  assert.deepEqual(
    catalog.slashCommands.map((command) => command.name),
    ["compact", "create-skill", "local:review"],
  );
  assert.equal(catalog.slashCommands[0]?.input?.hint, "optional context");
  assert.equal(catalog.skills.find((skill) => skill.name === "create-skill")?.scope, "bundled");
  assert.equal(catalog.skills.find((skill) => skill.name === "review")?.sourceCwd, "/repo");
  assert.equal(
    catalog.slashCommands.find((command) => command.name === "local:review")?.sourceCwd,
    "/repo",
  );
});

it("parseGrokInspectReport treats a JSON object without skills as empty", () => {
  const catalog = parseGrokInspectReport({ grokVersion: "1.0.4", ok: true });
  assert.deepEqual(catalog, { skills: [], slashCommands: [] });
});

it("resolveGrokPickerCatalog uses inspect as the skill authority", () => {
  const catalog = resolveGrokPickerCatalog({
    filesystemSkills: [
      {
        name: "fs-only",
        path: "/fs/fs-only/SKILL.md",
        enabled: true,
        scope: "project",
        sourceCwd: "/repo-b",
      },
    ],
    inspectCatalog: {
      skills: [
        {
          name: "create-skill",
          path: "/bundled/create-skill/SKILL.md",
          enabled: true,
          scope: "bundled",
        },
      ],
      slashCommands: [{ name: "create-skill", description: "Create a skill" }],
    },
    acpCatalog: {
      skills: [
        {
          name: "create-skill",
          path: "/bundled/create-skill/SKILL.md",
          enabled: true,
          scope: "bundled",
        },
      ],
      slashCommands: [
        { name: "compact", description: "Compress history" },
        { name: "create-skill", description: "Create a skill" },
      ],
    },
  });
  assert.deepEqual(
    catalog.skills.map((skill) => skill.name),
    ["create-skill"],
  );
  assert.deepEqual(
    catalog.slashCommands.map((command) => command.name),
    ["compact", "create-skill"],
  );
});

it("resolveGrokPickerCatalog unions filesystem and ACP skills when inspect is missing", () => {
  const catalog = resolveGrokPickerCatalog({
    filesystemSkills: [
      {
        name: "fs-only",
        path: "/fs/fs-only/SKILL.md",
        enabled: true,
        scope: "project",
        sourceCwd: "/repo-b",
      },
      {
        name: "shared",
        path: "/fs/shared/SKILL.md",
        enabled: true,
        scope: "user",
      },
    ],
    acpCatalog: {
      skills: [
        {
          name: "create-skill",
          path: "/bundled/create-skill/SKILL.md",
          enabled: true,
          scope: "bundled",
        },
        {
          name: "shared",
          path: "/bundled/shared/SKILL.md",
          enabled: true,
          scope: "bundled",
        },
      ],
      slashCommands: [{ name: "compact", description: "Compress history" }],
    },
  });
  assert.deepEqual(
    catalog.skills.map((skill) => skill.name),
    ["create-skill", "fs-only", "shared"],
  );
  assert.equal(catalog.skills.find((skill) => skill.name === "shared")?.scope, "bundled");
  assert.equal(catalog.slashCommands[0]?.name, "compact");
});

it("resolveGrokPickerCatalog keeps inspect commands when the ACP menu is empty", () => {
  const catalog = resolveGrokPickerCatalog({
    filesystemSkills: [],
    inspectCatalog: {
      skills: [],
      slashCommands: [{ name: "inspect-only" }],
    },
    acpCatalog: { skills: [], slashCommands: [] },
  });

  assert.deepEqual(
    catalog.slashCommands.map((command) => command.name),
    ["inspect-only"],
  );
});

it("resolveGrokPickerCatalog merges ACP commands under their probed cwd", () => {
  // The ACP probe session runs in one workspace; its menu must not wipe
  // inspect-derived commands from other workspaces.
  const catalog = resolveGrokPickerCatalog({
    filesystemSkills: [],
    inspectCatalog: {
      skills: [],
      slashCommands: [{ name: "review", sourceCwd: "/repo-b" }],
    },
    acpCatalog: {
      skills: [],
      slashCommands: [
        { name: "compact", description: "Compress history" },
        { name: "review", sourceCwd: "/repo-a" },
      ],
    },
  });

  assert.deepEqual(
    catalog.slashCommands.map((command) => [command.name, command.sourceCwd]),
    [
      ["compact", undefined],
      ["review", "/repo-a"],
      ["review", "/repo-b"],
    ],
  );
});

it("mergeGrokHarnessCatalogs keeps same-named workspace commands separate", () => {
  const catalog = mergeGrokHarnessCatalogs([
    { skills: [], slashCommands: [{ name: "review", sourceCwd: "/repo-a" }] },
    { skills: [], slashCommands: [{ name: "review", sourceCwd: "/repo-b" }] },
  ]);

  assert.deepEqual(
    catalog.slashCommands.map((command) => command.sourceCwd),
    ["/repo-a", "/repo-b"],
  );
});

it.layer(NodeServices.layer)("discoverGrokSkills", (it) => {
  it.effect("discovers Claude-compatible and native skills at the project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const workspace = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "gray-horizon-godot-loop",
        "---\nname: gray-horizon-godot-loop\ndescription: Godot loop skill.\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".grok", "skills"),
        "local-grok",
        "---\nname: local-grok\ndescription: Grok project skill.\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "agents-compatible",
        "---\nname: agents-compatible\ndescription: Agents compatibility skill.\n---\n",
      );

      const skills = yield* discoverGrokSkills(workspace);
      assert.ok(skills.some((skill) => skill.name === "gray-horizon-godot-loop"));
      assert.ok(skills.some((skill) => skill.name === "local-grok"));
      assert.ok(skills.some((skill) => skill.name === "agents-compatible"));
      assert.equal(
        skills.find((skill) => skill.name === "gray-horizon-godot-loop")?.scope,
        "project",
      );
    }),
  );

  it.effect("walks ancestors from nested cwd up to git root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const workspace = path.join(tempDir, "repo");
      const nested = path.join(workspace, "packages", "app");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "root-skill",
        "---\nname: root-skill\ndescription: From git root.\n---\n",
      );

      const skills = yield* discoverGrokSkills(nested);
      assert.ok(skills.some((skill) => skill.name === "root-skill"));
    }),
  );

  it.effect("prefers nested cwd skill over git-root skill on name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const workspace = path.join(tempDir, "repo");
      const nested = path.join(workspace, "packages", "app");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "shared",
        "---\nname: shared\ndescription: From git root.\n---\n",
      );
      yield* writeSkill(
        path.join(nested, ".claude", "skills"),
        "shared",
        "---\nname: shared\ndescription: From nested cwd.\n---\n",
      );

      const skills = yield* discoverGrokSkills(nested);
      const shared = skills.find((skill) => skill.name === "shared");
      assert.equal(shared?.description, "From nested cwd.");
      assert.ok(shared?.path.includes(`${path.sep}packages${path.sep}app${path.sep}`));
    }),
  );

  it.effect("prefers native .grok over Claude compatibility at the same directory tier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const workspace = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "shared",
        "---\nname: shared\ndescription: From Claude compatibility.\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".grok", "skills"),
        "shared",
        "---\nname: shared\ndescription: From native grok.\n---\n",
      );

      const skills = yield* discoverGrokSkills(workspace);
      assert.equal(
        skills.find((skill) => skill.name === "shared")?.description,
        "From native grok.",
      );
    }),
  );
});

it.layer(NodeServices.layer)("queryGrokInspectCatalog", (it) => {
  it.effect("parses inspect --json from the harness binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-inspect-" });
        const workspace = path.join(dir, "repo");
        yield* fs.makeDirectory(workspace, { recursive: true });
        const grokPath = path.join(dir, "grok");
        yield* fs.writeFileString(
          path.join(dir, "inspect.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed harness-owned fixture document.
          JSON.stringify({
            skills: [
              {
                name: "create-skill",
                description: "Create a skill.",
                source: { type: "bundled", path: "/bundled/create-skill/SKILL.md" },
                userInvocable: true,
              },
              {
                name: "project-review",
                description: "Review this repo.",
                source: {
                  type: "project",
                  path: `${workspace}/.grok/skills/project-review/SKILL.md`,
                },
                userInvocable: true,
              },
            ],
          }),
        );
        yield* fs.writeFileString(
          grokPath,
          [
            "#!/bin/sh",
            'if [ "$1" = "inspect" ]; then',
            '  cat "$(dirname "$0")/inspect.json"',
            "  exit 0",
            "fi",
            "exit 1",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(grokPath, 0o755);

        const catalog = yield* queryGrokInspectCatalog({
          binaryPath: grokPath,
          cwd: workspace,
        });
        assert.ok(catalog);
        assert.ok(catalog?.skills.some((skill) => skill.name === "create-skill"));
        assert.equal(
          catalog?.skills.find((skill) => skill.name === "project-review")?.sourceCwd,
          workspace,
        );
        assert.ok(catalog?.slashCommands.some((command) => command.name === "create-skill"));
        assert.equal(
          catalog?.slashCommands.find((command) => command.name === "project-review")?.sourceCwd,
          workspace,
        );
      }),
    ),
  );

  it.effect("parses a report after brace-containing diagnostics", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-inspect-noisy-" });
        const grokPath = path.join(dir, "grok");
        yield* fs.writeFileString(
          grokPath,
          [
            "#!/bin/sh",
            `printf '%s\\n' 'diagnostic {"status":"warming"}' '{"skills":[{"name":"review","source":{"type":"bundled","path":"/bundled/review/SKILL.md"},"userInvocable":true}]}'`,
            "exit 0",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(grokPath, 0o755);

        const catalog = yield* queryGrokInspectCatalog({ binaryPath: grokPath, cwd: dir });
        assert.equal(catalog?.skills[0]?.name, "review");
      }),
    ),
  );

  it.effect("returns undefined when inspect output is not a report", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-inspect-bad-" });
        const grokPath = path.join(dir, "grok");
        yield* fs.writeFileString(
          grokPath,
          ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
        );
        yield* fs.chmod(grokPath, 0o755);

        const catalog = yield* queryGrokInspectCatalog({
          binaryPath: grokPath,
          cwd: dir,
        });
        assert.equal(catalog, undefined);
      }),
    ),
  );

  it.effect("returns undefined when inspect JSON has no skills array", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-inspect-noskills-" });
        const grokPath = path.join(dir, "grok");
        yield* fs.writeFileString(
          grokPath,
          [
            "#!/bin/sh",
            'printf \'%s\\n\' \'{"grokVersion":"1.0.4","ok":true}\'',
            "exit 0",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(grokPath, 0o755);

        const catalog = yield* queryGrokInspectCatalog({
          binaryPath: grokPath,
          cwd: dir,
        });
        assert.equal(catalog, undefined);
      }),
    ),
  );

  it.effect("keeps filesystem project skills for a cwd whose inspect report is invalid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-inspect-partial-" });
        const good = path.join(dir, "good");
        const bad = path.join(dir, "bad");
        yield* fs.makeDirectory(path.join(good, ".git"), { recursive: true });
        yield* fs.makeDirectory(path.join(bad, ".git"), { recursive: true });
        yield* writeSkill(
          path.join(bad, ".grok", "skills"),
          "bad-fs",
          "---\nname: bad-fs\ndescription: From the failed inspect cwd.\n---\n",
        );
        yield* fs.writeFileString(
          path.join(dir, "inspect.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed harness-owned fixture document.
          JSON.stringify({
            skills: [
              {
                name: "good-inspect",
                description: "From the successful inspect cwd.",
                source: { type: "project", path: `${good}/.grok/skills/good-inspect/SKILL.md` },
                userInvocable: true,
              },
            ],
          }),
        );
        const grokPath = path.join(dir, "grok");
        yield* fs.writeFileString(
          grokPath,
          [
            "#!/bin/sh",
            'if [ "$1" = "inspect" ]; then',
            '  case "$PWD" in',
            "    */good)",
            '      cat "$(dirname "$0")/inspect.json"',
            "      exit 0",
            "      ;;",
            "  esac",
            "  printf '%s\\n' '{\"ok\":true}'",
            "  exit 0",
            "fi",
            "exit 1",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(grokPath, 0o755);

        const catalog = yield* queryGrokInspectCatalog({
          binaryPath: grokPath,
          cwd: [good, bad],
        });
        assert.ok(catalog);
        assert.ok(catalog?.skills.some((skill) => skill.name === "good-inspect"));
        assert.ok(catalog?.skills.some((skill) => skill.name === "bad-fs"));
        assert.equal(catalog?.skills.find((skill) => skill.name === "bad-fs")?.sourceCwd, bad);
      }),
    ),
  );
});
