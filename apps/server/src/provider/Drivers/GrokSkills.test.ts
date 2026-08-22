import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { discoverGrokSkills, parseGrokInspectSkills } from "./GrokSkills.ts";

const inspectPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });

const makeSpawnHandle = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(input.stdout ? Stream.make(input.stdout) : Stream.empty),
    stderr: Stream.encodeText(input.stderr ? Stream.make(input.stderr) : Stream.empty),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeNeverFinishingSpawnHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

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

  it("keeps Windows SKILL.md paths and Grok's global user scope", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "tdd",
          description: "Test-driven development.",
          source: {
            type: "user",
            path: "C:\\Users\\Drew\\.grok\\skills\\tdd\\SKILL.md",
          },
        },
        {
          name: "create-skill",
          source: {
            type: "bundled",
            path: "C:\\Users\\Drew\\.grok\\bundled\\skills\\create-skill\\SKILL.md",
          },
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "create-skill",
        path: "C:\\Users\\Drew\\.grok\\bundled\\skills\\create-skill\\SKILL.md",
        scope: "bundled",
        enabled: true,
      },
      {
        name: "tdd",
        description: "Test-driven development.",
        path: "C:\\Users\\Drew\\.grok\\skills\\tdd\\SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("accepts source.kind as an alias for source.type", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "kept",
          source: { kind: "project", path: "/repo/.grok/skills/kept/SKILL.md" },
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "kept",
        path: "/repo/.grok/skills/kept/SKILL.md",
        scope: "project",
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

  it("keeps the first entry when inspect repeats a skill name", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "review",
          source: { type: "user", path: "/home/dev/.grok/skills/review/SKILL.md" },
        },
        {
          name: "review",
          source: { type: "bundled", path: "/opt/grok/bundled/skills/review/SKILL.md" },
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "review",
        path: "/home/dev/.grok/skills/review/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("skips entries without a name or a filesystem path", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        { name: "  ", source: { type: "user", path: "/tmp/skills/a/SKILL.md" } },
        { name: "no-path", source: { type: "user" } },
        { name: "no-source" },
        { name: 42, source: { type: "user", path: "/tmp/skills/wrong-name/SKILL.md" } },
        { name: "wrong-source", source: "user" },
        "not-an-object",
        {
          name: "kept",
          source: { type: "project", path: "/repo/.grok/skills/kept/SKILL.md" },
          ignoredByT3: true,
        },
      ]),
    );

    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
  });

  it("parses JSON with a UTF-8 BOM or a warning preamble", () => {
    const body = inspectPayload([
      { name: "kept", source: { type: "user", path: "/home/dev/.grok/skills/kept/SKILL.md" } },
    ]);

    expect(parseGrokInspectSkills(`\uFEFF${body}`).map((skill) => skill.name)).toEqual(["kept"]);
    expect(
      parseGrokInspectSkills(`warn: inspect starting\n${body}`).map((skill) => skill.name),
    ).toEqual(["kept"]);
    expect(
      parseGrokInspectSkills(`warn: config contains {braces}\n${body}`).map((skill) => skill.name),
    ).toEqual(["kept"]);
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
        makeSpawnHandle({
          stdout: inspectPayload([
            {
              name: "kept",
              source: { type: "project", path: "/workspaces/demo/.grok/skills/kept/SKILL.md" },
            },
          ]),
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

  it.effect("fails open when the inspect process cannot spawn", () => {
    const spawnError = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      cause: new Error("grok executable unavailable"),
    });
    const spawner = ChildProcessSpawner.make(() => Effect.fail(spawnError));

    return Effect.gen(function* () {
      const exit = yield* discoverGrokSkills({ binaryPath: "grok" }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Effect.exit,
      );

      expect(exit).toMatchObject({ _tag: "Success", value: [] });
    });
  });

  it.effect("fails open when the inspect process exits non-zero", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSpawnHandle({ stderr: "inspect failed", exitCode: 7 })),
    );

    return Effect.gen(function* () {
      const exit = yield* discoverGrokSkills({ binaryPath: "grok" }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Effect.exit,
      );

      expect(exit).toMatchObject({ _tag: "Success", value: [] });
    });
  });

  it.effect("fails open when the inspect process times out", () => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingSpawnHandle()));

    return Effect.gen(function* () {
      const exitFiber = yield* discoverGrokSkills({ binaryPath: "grok" }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Effect.exit,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("4 seconds");
      const exit = yield* Fiber.join(exitFiber);

      expect(exit).toMatchObject({ _tag: "Success", value: [] });
    });
  });
});
