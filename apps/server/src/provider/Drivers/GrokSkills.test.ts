import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { discoverGrokSkills, parseGrokInspectSkills } from "./GrokSkills.ts";

const inspectPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });

describe("parseGrokInspectSkills", () => {
  it("maps inspect entries onto provider skills, sorted by name", () => {
    const skills = parseGrokInspectSkills(
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
    );

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
  });

  it("disables skills the CLI marks as not user-invocable", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "internal-helper",
          source: { type: "bundled", path: "/opt/grok/bundled/skills/internal-helper/SKILL.md" },
          userInvocable: false,
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "internal-helper",
        path: "/opt/grok/bundled/skills/internal-helper/SKILL.md",
        scope: "bundled",
        enabled: false,
      },
    ]);
  });

  it("skips entries without a name or a filesystem path", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        { name: "  ", source: { type: "user", path: "/tmp/skills/a/SKILL.md" } },
        { name: "no-path", source: { type: "user" } },
        { name: "no-source" },
        "not-an-object",
        { name: "kept", source: { type: "project", path: "/repo/.grok/skills/kept/SKILL.md" } },
      ]),
    );

    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
  });

  it("returns an empty list for malformed or unexpected output", () => {
    expect(parseGrokInspectSkills("not json")).toEqual([]);
    expect(parseGrokInspectSkills("null")).toEqual([]);
    expect(parseGrokInspectSkills(JSON.stringify({ skills: "nope" }))).toEqual([]);
    expect(parseGrokInspectSkills(JSON.stringify({}))).toEqual([]);
  });
});

describe("discoverGrokSkills", () => {
  it.effect("spawns the inspect probe in the configured cwd", () => {
    const spawnCwds: Array<string | undefined> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      spawnCwds.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(
            Stream.make(
              inspectPayload([
                {
                  name: "kept",
                  source: { type: "project", path: "/workspaces/demo/.grok/skills/kept/SKILL.md" },
                },
              ]),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });

    return Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {}, "/workspaces/demo").pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );

      expect(spawnCwds).toEqual(["/workspaces/demo"]);
      expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
    });
  });
});
