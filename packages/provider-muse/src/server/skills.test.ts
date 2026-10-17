import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { discoverMuseSkills, museSkillSelectorsInPrompt, parseMuseSkillsList } from "./skills.ts";

const payload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });
const makeSpawner = (stdout: string, exitCode = 0, commands: ChildProcess.Command[] = []) =>
  ChildProcessSpawner.make((command) => {
    commands.push(command);
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

describe("Muse skills", () => {
  it("maps CLI fields, paths and activation, sorts and keeps the first duplicate", () => {
    expect(
      parseMuseSkillsList(
        payload([
          {
            name: "plugin:ai-ugc:ugc-mode",
            path: "plugin://ai-ugc/skills/ugc-mode/SKILL.md",
            scope: "plugin",
            display_name: "UGC mode",
            description: "  Route work. ",
            short_description: " Routing ",
          },
          {
            id: "bundled:git",
            name: "git",
            path: "bundled://muse-core/skills/git/SKILL.md",
            scope: "bundled",
            display_name: "git",
            short_description: null,
          },
          {
            name: "local",
            path: ".agents/skills/local/SKILL.md",
            scope: "project",
            activation: "user-invocable-only",
            description: " ",
            short_description: " ",
          },
          {
            name: "off",
            path: "$HOME/.muse/skills/off/SKILL.md",
            scope: "user",
            activation: "off",
          },
          { name: "git", path: "/duplicate", description: "discard" },
          { name: " ", path: "/invalid" },
          { name: "no-path" },
          { path: "/no-name" },
          { name: "empty-path", path: " " },
          null,
          "bad",
          [],
        ]),
        { cwd: "/repo", home: "/home/dev" },
      ),
    ).toEqual([
      {
        name: "ai-ugc:ugc-mode",
        path: "plugin://ai-ugc/skills/ugc-mode/SKILL.md",
        scope: "plugin",
        enabled: true,
        displayName: "UGC mode",
        description: "Route work.",
        shortDescription: "Routing",
      },
      {
        name: "git",
        path: "bundled://muse-core/skills/git/SKILL.md",
        scope: "bundled",
        enabled: true,
      },
      {
        name: "local",
        path: "/repo/.agents/skills/local/SKILL.md",
        scope: "project",
        enabled: true,
        userInvocationOnly: true,
      },
      { name: "off", path: "/home/dev/.muse/skills/off/SKILL.md", scope: "user", enabled: false },
    ]);
  });

  it("preserves absolute paths and paths without a workspace", () => {
    expect(
      parseMuseSkillsList(
        payload([
          { name: "a", path: "/skills/a" },
          { name: "b", path: "skills/b" },
        ]),
        { home: "/home/dev" },
      ),
    ).toEqual([
      { name: "a", path: "/skills/a", enabled: true },
      { name: "b", path: "skills/b", enabled: true },
    ]);
  });

  it.effect("passes workspace flags and spawn cwd only for a workspace probe", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = [];
      for (const cwd of [undefined, "/workspaces/demo"]) {
        const skills = yield* discoverMuseSkills(
          { binaryPath: "muse" },
          { HOME: "/home/dev" },
          cwd,
        ).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner(payload([{ name: "local", path: "skills/local" }]), 0, commands),
          ),
        );
        expect(skills[0]?.path).toBe(cwd ? "/workspaces/demo/skills/local" : "skills/local");
      }
      expect(
        commands.map((command) =>
          command._tag === "StandardCommand"
            ? { args: command.args, cwd: command.options?.cwd }
            : null,
        ),
      ).toEqual([
        { args: ["skills", "list", "--json"], cwd: undefined },
        {
          args: [
            "skills",
            "list",
            "--json",
            "--workspace",
            "/workspaces/demo",
            "--trust-workspace",
          ],
          cwd: "/workspaces/demo",
        },
      ]);
    }),
  );

  it.effect("resolves home from HOME, USERPROFILE, then the host", () =>
    Effect.gen(function* () {
      for (const [environment, home] of [
        [{ HOME: "/home/dev", USERPROFILE: "/profile" }, "/home/dev"],
        [{ USERPROFILE: "/profile" }, "/profile"],
        [{}, "/host/home"],
      ] as const) {
        const skills = yield* discoverMuseSkills({ binaryPath: "muse" }, environment).pipe(
          Effect.provideService(HostProcess.HomeDirectory, "/host/home"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner(payload([{ name: "a", path: "$HOME/skills/a" }])),
          ),
        );
        expect(skills[0]?.path).toBe(`${home}/skills/a`);
      }
    }),
  );

  it.effect("rejects malformed payloads as decode errors", () =>
    Effect.gen(function* () {
      for (const stdout of ["not json", "null", '{"skills":"nope"}', "{}", "[]"]) {
        const error = yield* discoverMuseSkills({ binaryPath: "muse" }, {}).pipe(
          Effect.flip,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeSpawner(stdout)),
        );
        expect(error).toMatchObject({ _tag: "MuseSkillsProbeError", stage: "decode" });
      }
    }),
  );

  it.effect("reports nonzero exits and spawn failures with their workspace", () =>
    Effect.gen(function* () {
      const error = yield* discoverMuseSkills({ binaryPath: "muse" }, {}, "/repo").pipe(
        Effect.flip,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeSpawner(payload([]), 7)),
      );
      expect(error).toMatchObject({
        _tag: "MuseSkillsProbeError",
        stage: "exit",
        exitCode: 7,
        cwd: "/repo",
      });
      const cause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "missing binary",
      });
      const failed = yield* discoverMuseSkills({ binaryPath: "muse" }, {}, "/repo").pipe(
        Effect.flip,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.fail(cause)),
        ),
      );
      expect(failed).toMatchObject({ _tag: "MuseSkillsProbeError", stage: "spawn", cwd: "/repo" });
    }),
  );

  it.effect("bounds a stalled spawn with a timeout", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fiber = yield* discoverMuseSkills({ binaryPath: "muse" }, {}, "/repo").pipe(
        Effect.flip,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(4_000);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "MuseSkillsProbeError",
        stage: "timeout",
        cwd: "/repo",
      });
    }),
  );

  it("matches only catalog selectors once, in mention order", () => {
    expect(museSkillSelectorsInPrompt("$git a $git $nope", new Set(["git"]))).toEqual(["git"]);
    expect(
      museSkillSelectorsInPrompt("$ai-ugc:ugc-mode $git", new Set(["git", "ai-ugc:ugc-mode"])),
    ).toEqual(["ai-ugc:ugc-mode", "git"]);
    expect(museSkillSelectorsInPrompt("$100 git", new Set(["git"]))).toEqual([]);
  });
});
