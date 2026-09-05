import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { discoverGrokSkills } from "./GrokSkills.ts";

const inspectPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });

const makeInspectSpawner = (stdout: string, exitCode = 0, spawnCwds?: Array<string | undefined>) =>
  ChildProcessSpawner.make((command) => {
    spawnCwds?.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

describe("discoverGrokSkills", () => {
  it.effect("maps inspect entries onto provider skills, sorted by name", () =>
    Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {});

      expect(skills).toEqual([
        {
          name: "deploy",
          description: "Deploy the app.",
          path: "/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md",
          scope: "plugin",
          enabled: true,
        },
        {
          name: "writing-docs",
          description: "Write user docs.",
          path: "/home/dev/.grok/skills/writing-docs/SKILL.md",
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeInspectSpawner(
          inspectPayload([
            {
              name: "writing-docs",
              description: "Write user docs.",
              source: { type: "user", path: "/home/dev/.grok/skills/writing-docs/SKILL.md" },
              userInvocable: true,
            },
            {
              name: "deploy",
              description: "Deploy the app.",
              source: {
                type: "plugin",
                path: "/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md",
              },
              userInvocable: true,
            },
          ]),
        ),
      ),
    ),
  );

  it.effect("disables skills the CLI marks as not user-invocable", () =>
    Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {});

      expect(skills).toEqual([
        {
          name: "internal-helper",
          path: "/opt/grok/bundled/skills/internal-helper/SKILL.md",
          scope: "bundled",
          enabled: false,
        },
      ]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeInspectSpawner(
          inspectPayload([
            {
              name: "internal-helper",
              source: {
                type: "bundled",
                path: "/opt/grok/bundled/skills/internal-helper/SKILL.md",
              },
              userInvocable: false,
            },
          ]),
        ),
      ),
    ),
  );

  it.effect("skips entries without a name or a filesystem path", () =>
    Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {});
      expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeInspectSpawner(
          inspectPayload([
            { name: "  ", source: { type: "user", path: "/tmp/skills/a/SKILL.md" } },
            { name: "no-path", source: { type: "user" } },
            { name: "no-source" },
            "not-an-object",
            { name: "kept", source: { type: "project", path: "/repo/.grok/skills/kept/SKILL.md" } },
          ]),
        ),
      ),
    ),
  );

  it.effect("rejects malformed or unexpected output as a decode failure", () =>
    Effect.gen(function* () {
      for (const stdout of ["not json", "null", '{"skills":"nope"}', "{}"]) {
        const error = yield* discoverGrokSkills({ binaryPath: "grok" }, {}).pipe(
          Effect.flip,
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeInspectSpawner(stdout),
          ),
        );
        expect(error).toMatchObject({ _tag: "GrokSkillsProbeError", stage: "decode" });
      }
    }),
  );

  it.effect("spawns in the configured cwd and rejects a failed probe", () => {
    const spawnCwds: Array<string | undefined> = [];
    const stdout = inspectPayload([
      {
        name: "kept",
        source: { type: "project", path: "/workspaces/demo/.grok/skills/kept/SKILL.md" },
      },
    ]);

    return Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {}, "/workspaces/demo").pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeInspectSpawner(stdout, 0, spawnCwds),
        ),
      );

      expect(spawnCwds).toEqual(["/workspaces/demo"]);
      expect(skills.map((skill) => skill.name)).toEqual(["kept"]);

      const failed = yield* discoverGrokSkills({ binaryPath: "grok" }).pipe(
        Effect.result,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeInspectSpawner(stdout, 1),
        ),
      );
      expect(failed._tag).toBe("Failure");
    });
  });
});
