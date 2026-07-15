import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { listGrokSkills, parseGrokInspectSkills } from "./GrokSkillDiscovery.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const inspectPayload = encodeJson({
  ignoredTopLevelField: true,
  skills: [
    {
      name: "project-skill",
      description: "Project instructions",
      source: { type: "project", path: "/repo/.grok/skills/project-skill/SKILL.md" },
      userInvocable: true,
      displayName: "Project Skill",
      shortDescription: "Project summary",
    },
    {
      name: "user-skill",
      source: { type: "user", path: "/home/test/.grok/skills/user-skill/SKILL.md" },
      userInvocable: true,
    },
    {
      name: "bundled-skill",
      source: { type: "bundled", path: "/home/test/.grok/skills/bundled/SKILL.md" },
      userInvocable: true,
    },
    {
      name: "config-skill",
      source: { type: "config", path: "/team/config-skill/SKILL.md" },
      userInvocable: true,
    },
    {
      name: "server-skill",
      source: { type: "server", path: "/managed/server-skill/SKILL.md" },
      userInvocable: true,
    },
    {
      name: "plugin:review",
      source: {
        type: "plugin",
        plugin: "review-tools",
        path: "/plugins/review-tools/skills/review/SKILL.md",
      },
      userInvocable: true,
    },
    {
      name: "disabled-skill",
      source: { type: "project", path: "/repo/.grok/skills/disabled/SKILL.md" },
      userInvocable: true,
      disabled: true,
    },
    {
      name: "model-only",
      source: { type: "project", path: "/repo/.grok/skills/model-only/SKILL.md" },
      userInvocable: false,
    },
  ],
});

it.effect("maps Grok inspect skills into the shared provider contract", () =>
  Effect.gen(function* () {
    const skills = yield* parseGrokInspectSkills(inspectPayload);

    assert.deepStrictEqual(
      skills.map((skill) => ({ name: skill.name, scope: skill.scope, enabled: skill.enabled })),
      [
        { name: "project-skill", scope: "project", enabled: true },
        { name: "user-skill", scope: "user", enabled: true },
        { name: "bundled-skill", scope: "bundled", enabled: true },
        { name: "config-skill", scope: "config", enabled: true },
        { name: "server-skill", scope: "server", enabled: true },
        { name: "plugin:review", scope: "plugin:review-tools", enabled: true },
        { name: "disabled-skill", scope: "project", enabled: false },
      ],
    );
    assert.deepInclude(skills[0], {
      displayName: "Project Skill",
      shortDescription: "Project summary",
      description: "Project instructions",
    });
  }),
);

it.effect("rejects malformed and structurally invalid inspect output", () =>
  Effect.gen(function* () {
    const malformed = yield* Effect.flip(parseGrokInspectSkills("not-json"));
    const missingPath = yield* Effect.flip(
      parseGrokInspectSkills(
        encodeJson({
          skills: [{ name: "broken", source: { type: "project" }, userInvocable: true }],
        }),
      ),
    );
    const emptyName = yield* Effect.flip(
      parseGrokInspectSkills(
        encodeJson({
          skills: [
            {
              name: "   ",
              source: { type: "project", path: "/skills/broken/SKILL.md" },
              userInvocable: true,
            },
          ],
        }),
      ),
    );

    assert.equal(malformed.operation, "decode");
    assert.equal(missingPath.operation, "decode");
    assert.equal(emptyName.operation, "decode");
  }),
);

it.layer(NodeServices.layer)("listGrokSkills", (it) => {
  it.effect("uses the configured binary, cwd, arguments, and environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-skills-" });
        const binaryPath = path.join(dir, "grok-custom");
        const argsPath = path.join(dir, "args.txt");
        const envPath = path.join(dir, "env.txt");
        const cwdPath = path.join(dir, "cwd.txt");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'printf "%s\\n" "$@" > "$T3_GROK_ARGS_PATH"',
            'printf "%s" "$T3_GROK_MARKER" > "$T3_GROK_ENV_PATH"',
            'pwd > "$T3_GROK_CWD_PATH"',
            `printf '%s' '${inspectPayload}'`,
            "",
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const skills = yield* listGrokSkills({
          settings: { binaryPath },
          cwd: dir,
          environment: {
            ...process.env,
            T3_GROK_ARGS_PATH: argsPath,
            T3_GROK_ENV_PATH: envPath,
            T3_GROK_CWD_PATH: cwdPath,
            T3_GROK_MARKER: "environment-forwarded",
          },
        });

        assert.equal(skills[0]?.name, "project-skill");
        assert.deepStrictEqual((yield* fs.readFileString(argsPath)).trim().split("\n"), [
          "--cwd",
          dir,
          "inspect",
          "--json",
        ]);
        assert.equal(yield* fs.readFileString(envPath), "environment-forwarded");
        assert.equal(
          yield* fs.realPath((yield* fs.readFileString(cwdPath)).trim()),
          yield* fs.realPath(dir),
        );
      }),
    ),
  );

  it.effect("returns typed failures for non-zero exits and malformed JSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-errors-" });
        const failingPath = path.join(dir, "grok-failing");
        const malformedPath = path.join(dir, "grok-malformed");
        yield* fs.writeFileString(failingPath, "#!/bin/sh\nexit 7\n");
        yield* fs.writeFileString(malformedPath, "#!/bin/sh\nprintf 'not-json'\n");
        yield* fs.chmod(failingPath, 0o755);
        yield* fs.chmod(malformedPath, 0o755);

        const failed = yield* Effect.flip(
          listGrokSkills({ settings: { binaryPath: failingPath }, cwd: dir }),
        );
        const malformed = yield* Effect.flip(
          listGrokSkills({ settings: { binaryPath: malformedPath }, cwd: dir }),
        );

        assert.equal(failed.operation, "run");
        assert.include(failed.detail, "code 7");
        assert.equal(malformed.operation, "decode");
      }),
    ),
  );

  it.effect("times out a hung Grok inspect process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-timeout-" });
        const binaryPath = path.join(dir, "grok-hanging");
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\nsleep 60\n");
        yield* fs.chmod(binaryPath, 0o755);

        const fiber = yield* listGrokSkills({
          settings: { binaryPath },
          cwd: dir,
          timeout: Duration.millis(5),
        }).pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(10));
        const error = yield* Fiber.join(fiber);

        assert.equal(error.operation, "timeout");
      }),
    ),
  );
});
