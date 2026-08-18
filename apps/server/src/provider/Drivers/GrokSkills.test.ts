import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";

import { DEFAULT_TIMEOUT_MS } from "../providerSnapshot.ts";
import { discoverGrokSkills, parseGrokInspectSkills } from "./GrokSkills.ts";

const hangingInspectSpawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
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
    }),
  ),
);

const inspectSpawner = (stdout: string, code: number) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
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
    ),
  );

describe("parseGrokInspectSkills", () => {
  it("maps inspect JSON onto ServerProviderSkill rows", () => {
    expect(
      parseGrokInspectSkills({
        skills: [
          {
            name: "handoff-session",
            description: "Write a session handoff.",
            userInvocable: true,
            source: { type: "user", path: "/tmp/.grok/skills/handoff-session/SKILL.md" },
          },
          {
            name: "ce-plan",
            description: "Create structured plans.",
            userInvocable: true,
            source: {
              type: "plugin",
              plugin_name: "compound-engineering",
              path: "/tmp/plugins/ce-plan/SKILL.md",
            },
          },
        ],
      }),
    ).toEqual([
      {
        name: "handoff-session",
        description: "Write a session handoff.",
        path: "/tmp/.grok/skills/handoff-session/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "ce-plan",
        description: "Create structured plans.",
        path: "/tmp/plugins/ce-plan/SKILL.md",
        scope: "plugin:compound-engineering",
        enabled: true,
      },
    ]);
  });

  it("skips malformed rows and keeps the first name on collisions", () => {
    expect(
      parseGrokInspectSkills({
        skills: [
          {
            name: "review",
            source: { type: "project", path: "/repo/.grok/skills/review/SKILL.md" },
          },
          { name: "review", source: { type: "user", path: "/home/.grok/skills/review/SKILL.md" } },
          { name: "broken" },
          null,
          "nope",
        ],
      }),
    ).toEqual([
      {
        name: "review",
        path: "/repo/.grok/skills/review/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ]);
  });

  it("marks non-invocable or disabled skills as disabled", () => {
    const skills = parseGrokInspectSkills({
      skills: [
        {
          name: "hidden",
          userInvocable: false,
          source: { type: "bundled", path: "/bundled/hidden/SKILL.md" },
        },
        {
          name: "off",
          disabled: true,
          source: { type: "user", path: "/home/.grok/skills/off/SKILL.md" },
        },
      ],
    });
    expect(skills.map((skill) => ({ name: skill.name, enabled: skill.enabled }))).toEqual([
      { name: "hidden", enabled: false },
      { name: "off", enabled: false },
    ]);
  });

  it("returns an empty list for junk input", () => {
    expect(parseGrokInspectSkills(null)).toEqual([]);
    expect(parseGrokInspectSkills({})).toEqual([]);
    expect(parseGrokInspectSkills({ skills: "nope" })).toEqual([]);
  });
});

describe("discoverGrokSkills", () => {
  it.effect("returns [] when inspect starts but never exits", () =>
    Effect.gen(function* () {
      const fiber = yield* discoverGrokSkills({ binaryPath: process.execPath }).pipe(
        Effect.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, hangingInspectSpawner),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(DEFAULT_TIMEOUT_MS));
      expect(yield* Fiber.join(fiber)).toEqual([]);
    }),
  );

  it.effect("keeps a successful inspect catalog", () =>
    Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: process.execPath }).pipe(
        Effect.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            inspectSpawner(
              JSON.stringify({
                skills: [
                  {
                    name: "handoff-session",
                    description: "Write a session handoff.",
                    userInvocable: true,
                    source: { type: "user", path: "/tmp/.grok/skills/handoff-session/SKILL.md" },
                  },
                ],
              }),
              0,
            ),
          ),
        ),
      );
      expect(skills).toEqual([
        {
          name: "handoff-session",
          description: "Write a session handoff.",
          path: "/tmp/.grok/skills/handoff-session/SKILL.md",
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("returns [] when inspect exits non-zero", () =>
    Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: process.execPath }).pipe(
        Effect.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            inspectSpawner("inspect failed: secret-token-value", 2),
          ),
        ),
      );
      expect(skills).toEqual([]);
    }),
  );
});
