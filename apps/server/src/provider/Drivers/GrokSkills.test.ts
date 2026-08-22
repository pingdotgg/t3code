import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverGrokSkills,
  parseGrokInspectSkills,
  parseGrokInspectSkillsJson,
} from "./GrokSkills.ts";

describe("parseGrokInspectSkills", () => {
  it("maps inspect skills into ServerProviderSkill entries", () => {
    const skills = parseGrokInspectSkills({
      skills: [
        {
          name: "super-review",
          description: "Bugs-only super review.",
          userInvocable: true,
          source: {
            type: "user",
            path: "/Users/me/.grok/skills/super-review/SKILL.md",
          },
        },
        {
          name: "docx",
          description: "Office docs helper.",
          userInvocable: false,
          source: {
            type: "bundled",
            path: "/Users/me/.grok/bundled/skills/docx/SKILL.md",
          },
        },
        {
          name: "test-t3-app",
          description: "Launch T3 for testing.",
          userInvocable: true,
          source: {
            type: "project",
            path: "/repo/.agents/skills/test-t3-app/SKILL.md",
          },
        },
      ],
    });

    assert.deepEqual(skills, [
      {
        name: "docx",
        description: "Office docs helper.",
        path: "/Users/me/.grok/bundled/skills/docx/SKILL.md",
        scope: "bundled",
        enabled: false,
      },
      {
        name: "super-review",
        description: "Bugs-only super review.",
        path: "/Users/me/.grok/skills/super-review/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "test-t3-app",
        description: "Launch T3 for testing.",
        path: "/repo/.agents/skills/test-t3-app/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ]);
  });

  it("skips entries missing a name or path", () => {
    const skills = parseGrokInspectSkills({
      skills: [
        { name: "ok", source: { type: "user", path: "/tmp/ok/SKILL.md" }, userInvocable: true },
        { name: "no-path", source: { type: "user" }, userInvocable: true },
        { source: { type: "user", path: "/tmp/noname/SKILL.md" }, userInvocable: true },
        "not-an-object",
        null,
      ],
    });

    assert.deepEqual(skills, [
      {
        name: "ok",
        path: "/tmp/ok/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("returns an empty list for invalid JSON documents", () => {
    assert.deepEqual(parseGrokInspectSkillsJson("{not json"), []);
    assert.deepEqual(parseGrokInspectSkills(null), []);
    assert.deepEqual(parseGrokInspectSkills({ skills: "nope" }), []);
  });

  it("skips non-string name/path fields without throwing", () => {
    const skills = parseGrokInspectSkills({
      skills: [
        { name: 1, source: { type: "user", path: "/tmp/num/SKILL.md" }, userInvocable: true },
        {
          name: "ok",
          source: { type: "user", path: "/tmp/ok/SKILL.md" },
          userInvocable: true,
        },
        {
          name: "bad-path",
          source: { type: "user", path: 42 },
          userInvocable: true,
        },
      ],
    });

    assert.deepEqual(skills, [
      {
        name: "ok",
        path: "/tmp/ok/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("dedupes by name with project scope beating user/bundled", () => {
    const skills = parseGrokInspectSkills({
      skills: [
        {
          name: "review",
          description: "User last",
          userInvocable: true,
          source: { type: "user", path: "/user/review/SKILL.md" },
        },
        {
          name: "review",
          description: "Project first",
          userInvocable: true,
          source: { type: "project", path: "/repo/review/SKILL.md" },
        },
        {
          name: "review",
          description: "Bundled last",
          userInvocable: true,
          source: { type: "bundled", path: "/bundled/review/SKILL.md" },
        },
      ],
    });

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.path, "/repo/review/SKILL.md");
    assert.equal(skills[0]?.scope, "project");
    assert.equal(skills[0]?.description, "Project first");
  });

  it("dedupes same-scope names by keeping the later inspect entry", () => {
    const skills = parseGrokInspectSkills({
      skills: [
        {
          name: "review",
          description: "First",
          userInvocable: true,
          source: { type: "user", path: "/user/a/SKILL.md" },
        },
        {
          name: "review",
          description: "Second",
          userInvocable: true,
          source: { type: "user", path: "/user/b/SKILL.md" },
        },
      ],
    });

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.path, "/user/b/SKILL.md");
    assert.equal(skills[0]?.description, "Second");
  });
});

it.layer(NodeServices.layer)("discoverGrokSkills", (it) => {
  it.effect("parses skills from a fake grok inspect --json binary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-skills-" });
      const grokPath = path.join(dir, "grok");
      const inspectPayload = JSON.stringify({
        skills: [
          {
            name: "apple-design",
            description: "Apple HIG skill.",
            userInvocable: true,
            source: {
              type: "user",
              path: "/Users/me/.grok/skills/apple-design/SKILL.md",
            },
          },
        ],
      });
      yield* fs.writeFileString(
        grokPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then',
          `  printf '%s\\n' '${inspectPayload.replace(/'/g, `'\\''`)}'`,
          "  exit 0",
          "fi",
          "echo unexpected >&2",
          "exit 1",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(grokPath, 0o755);

      const skills = yield* discoverGrokSkills({ binaryPath: grokPath }, dir);

      assert.deepEqual(skills, [
        {
          name: "apple-design",
          description: "Apple HIG skill.",
          path: "/Users/me/.grok/skills/apple-design/SKILL.md",
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("returns an empty list when inspect fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-skills-fail-" });
      const grokPath = path.join(dir, "grok");
      yield* fs.writeFileString(grokPath, ["#!/bin/sh", "exit 2", ""].join("\n"));
      yield* fs.chmod(grokPath, 0o755);

      const skills = yield* discoverGrokSkills({ binaryPath: grokPath }, dir);
      assert.deepEqual(skills, []);
    }),
  );
});
