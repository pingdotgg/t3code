import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveUsageTranscriptDirs } from "./usageTranscriptDirs.ts";

/**
 * Homes that do not exist on disk, so the `~/.claude/projects` probe always
 * takes the "config dir is the home itself" branch and the expectations below
 * hold on any machine.
 */
const fixtureHomes = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.resolve("/tmp/t3-usage-test");
  return {
    claudeDefault: path.join(root, "claude-default"),
    claudeWork: path.join(root, "claude-work"),
    claudePersonal: path.join(root, "claude-personal"),
    codexDefault: path.join(root, "codex-default"),
    codexPersonalShadow: path.join(root, "codex-personal"),
    claudeProjects: (home: string) => path.join(home, "projects"),
    codexSessions: (home: string) => path.join(home, "sessions"),
  };
});

const claudeInstance = (homePath: string): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  config: { homePath },
});

function settingsWith(input: {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly providerInstances?: Record<string, ProviderInstanceConfig>;
}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        homePath: input.claudeHomePath,
      },
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        homePath: input.codexHomePath,
      },
    },
    providerInstances: (input.providerInstances ?? {}) as ServerSettings["providerInstances"],
  };
}

it.layer(NodeServices.layer)("resolveUsageTranscriptDirs", (it) => {
  it.effect("scans the legacy provider home when no instances are configured", () =>
    Effect.gen(function* () {
      const homes = yield* fixtureHomes;
      const dirs = yield* resolveUsageTranscriptDirs(
        settingsWith({ claudeHomePath: homes.claudeDefault, codexHomePath: homes.codexDefault }),
      );

      expect(dirs).toEqual([
        { provider: "claude", dir: homes.claudeProjects(homes.claudeDefault) },
        { provider: "codex", dir: homes.codexSessions(homes.codexDefault) },
      ]);
    }),
  );

  it.effect("scans every configured home of the same driver", () =>
    Effect.gen(function* () {
      const homes = yield* fixtureHomes;
      const dirs = yield* resolveUsageTranscriptDirs(
        settingsWith({
          claudeHomePath: homes.claudeDefault,
          codexHomePath: homes.codexDefault,
          providerInstances: {
            claude_work: claudeInstance(homes.claudeWork),
            claude_personal: claudeInstance(homes.claudePersonal),
          },
        }),
      );

      expect(dirs.filter((entry) => entry.provider === "claude")).toEqual([
        { provider: "claude", dir: homes.claudeProjects(homes.claudeDefault) },
        { provider: "claude", dir: homes.claudeProjects(homes.claudeWork) },
        { provider: "claude", dir: homes.claudeProjects(homes.claudePersonal) },
      ]);
    }),
  );

  it.effect("drops the legacy home once an instance claims the driver's default id", () =>
    Effect.gen(function* () {
      const homes = yield* fixtureHomes;
      const dirs = yield* resolveUsageTranscriptDirs(
        settingsWith({
          claudeHomePath: homes.claudeDefault,
          codexHomePath: homes.codexDefault,
          providerInstances: { claudeAgent: claudeInstance(homes.claudeWork) },
        }),
      );

      expect(dirs.filter((entry) => entry.provider === "claude")).toEqual([
        { provider: "claude", dir: homes.claudeProjects(homes.claudeWork) },
      ]);
    }),
  );

  it.effect("scans a directory shared by two instances once", () =>
    Effect.gen(function* () {
      const homes = yield* fixtureHomes;
      const dirs = yield* resolveUsageTranscriptDirs(
        settingsWith({
          claudeHomePath: homes.claudeDefault,
          codexHomePath: homes.codexDefault,
          providerInstances: {
            claude_work: claudeInstance(homes.claudeWork),
            claude_work_copy: claudeInstance(homes.claudeWork),
          },
        }),
      );

      expect(
        dirs.filter((entry) => entry.dir === homes.claudeProjects(homes.claudeWork)),
      ).toHaveLength(1);
    }),
  );

  it.effect("skips an instance whose config envelope cannot be decoded", () =>
    Effect.gen(function* () {
      const homes = yield* fixtureHomes;
      const dirs = yield* resolveUsageTranscriptDirs(
        settingsWith({
          claudeHomePath: homes.claudeDefault,
          codexHomePath: homes.codexDefault,
          providerInstances: {
            claude_broken: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: 42 },
            },
            claude_work: claudeInstance(homes.claudeWork),
          },
        }),
      );

      expect(dirs.filter((entry) => entry.provider === "claude")).toEqual([
        { provider: "claude", dir: homes.claudeProjects(homes.claudeDefault) },
        { provider: "claude", dir: homes.claudeProjects(homes.claudeWork) },
      ]);
    }),
  );

  it.effect("ignores instances belonging to another driver", () =>
    Effect.gen(function* () {
      const homes = yield* fixtureHomes;
      const dirs = yield* resolveUsageTranscriptDirs(
        settingsWith({
          claudeHomePath: homes.claudeDefault,
          codexHomePath: homes.codexDefault,
          providerInstances: {
            cursor_main: {
              driver: ProviderDriverKind.make("cursor"),
              config: { homePath: homes.claudeWork },
            },
          },
        }),
      );

      expect(dirs).toEqual([
        { provider: "claude", dir: homes.claudeProjects(homes.claudeDefault) },
        { provider: "codex", dir: homes.codexSessions(homes.codexDefault) },
      ]);
    }),
  );

  it.effect("reads a Codex shadow home from its shared home, not the private shadow", () =>
    Effect.gen(function* () {
      const homes = yield* fixtureHomes;
      const dirs = yield* resolveUsageTranscriptDirs(
        settingsWith({
          claudeHomePath: homes.claudeDefault,
          codexHomePath: homes.codexDefault,
          providerInstances: {
            codex_personal: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                homePath: homes.codexDefault,
                shadowHomePath: homes.codexPersonalShadow,
              },
            },
          },
        }),
      );

      // The shadow home only isolates auth.json; sessions live in the shared
      // home, which the legacy entry already contributed.
      expect(dirs.filter((entry) => entry.provider === "codex")).toEqual([
        { provider: "codex", dir: homes.codexSessions(homes.codexDefault) },
      ]);
    }),
  );
});
