import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { isCopilotAcpSettings } from "./copilotAcp.ts";
import {
  applyCopilotDiscoveredSkills,
  CopilotSkillsProbeError,
  decodeCopilotSkillList,
  discoverCopilotSkills,
  filterCopilotSlashCommands,
  isCopilotAdvertisedSkill,
  leadingCopilotSkillMention,
} from "./copilotSkills.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

interface RecordedSpawn {
  readonly command: string;
  readonly args: ChildProcess.StandardCommand["args"];
  readonly options: ChildProcess.CommandOptions | undefined;
}

const makeCatalog = (
  resolve: AcpRegistrySupport.AcpRegistryCatalog["Service"]["resolve"],
): AcpRegistrySupport.AcpRegistryCatalog["Service"] => ({
  search: () => Effect.die("unused search"),
  prepare: () => Effect.die("unused prepare"),
  inspect: () => Effect.die("unused inspect"),
  resolve,
  uninstallManagedBinary: () => Effect.die("unused uninstall"),
});

const makeResolvedCatalog = (input: {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly calls?: Array<{
    readonly settings: AcpRegistrySettings;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv | undefined;
  }>;
}): AcpRegistrySupport.AcpRegistryCatalog["Service"] =>
  makeCatalog((settings, cwd, environment) => {
    input.calls?.push({ settings, cwd, environment });
    const env = input.env ?? environment;
    return Effect.succeed({
      distribution: "local",
      spawn: {
        command: input.command ?? "/usr/local/bin/copilot",
        args: ["--acp"],
        cwd,
        ...(env ? { env } : {}),
      },
    });
  });

const makeSpawner = (options: {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly hang?: boolean;
  readonly failSpawn?: boolean;
  readonly spawns?: Array<RecordedSpawn>;
}) =>
  ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") {
      options.spawns?.push({
        command: command.command,
        args: command.args,
        options: command.options,
      });
    }
    if (options.failSpawn) {
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "copilot binary not found",
        }),
      );
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: options.hang
          ? Effect.never
          : Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
        isRunning: Effect.succeed(Boolean(options.hang)),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: options.hang
          ? Stream.never
          : Stream.encodeText(Stream.make(options.stdout ?? "[]")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

function makeProviderSnapshot(input: {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
    driver: ProviderDriverKind.make("acpRegistry"),
    displayName: "GitHub Copilot",
    continuation: { groupKey: "acpRegistry:instance:acpRegistry_copilot" },
    supportsTextGeneration: false,
    enabled: true,
    installed: true,
    version: "1.0.105",
    status: "ready",
    auth: { status: "authenticated", canLogout: false },
    checkedAt: "2026-11-23T12:00:00.000Z",
    setup: { canInstall: false, canAuthenticate: true },
    models: [],
    slashCommands: input.slashCommands,
    skills: input.skills ?? [],
  };
}

describe("isCopilotAcpSettings", () => {
  it.each([
    {
      label: "registry github-copilot-cli",
      settings: { source: "registry" as const, agentId: "github-copilot-cli", commandPath: "" },
      expected: true,
    },
    {
      label: "local bare copilot",
      settings: { source: "local" as const, agentId: "", commandPath: "copilot" },
      expected: true,
    },
    {
      label: "local copilot.exe",
      settings: { source: "local" as const, agentId: "", commandPath: "copilot.exe" },
      expected: true,
    },
    {
      label: "local Windows path with COPILOT.CMD",
      settings: {
        source: "local" as const,
        agentId: "",
        commandPath: "C:\\Program Files\\Copilot\\COPILOT.CMD",
      },
      expected: true,
    },
    {
      label: "local POSIX path /usr/local/bin/copilot",
      settings: { source: "local" as const, agentId: "", commandPath: "/usr/local/bin/copilot" },
      expected: true,
    },
    {
      label: "non-copilot registry agent",
      settings: { source: "registry" as const, agentId: "opencode", commandPath: "" },
      expected: false,
    },
    {
      label: "registry agent with copilot commandPath override but different agentId",
      settings: { source: "registry" as const, agentId: "devin", commandPath: "copilot" },
      expected: false,
    },
    {
      label: "local non-copilot agent",
      settings: { source: "local" as const, agentId: "", commandPath: "/usr/local/bin/opencode" },
      expected: false,
    },
    {
      label: "local command containing copilot as prefix",
      settings: {
        source: "local" as const,
        agentId: "github-copilot-cli",
        commandPath: "/usr/local/bin/copilot-helper",
      },
      expected: false,
    },
    {
      label: "local empty commandPath",
      settings: { source: "local" as const, agentId: "github-copilot-cli", commandPath: "" },
      expected: false,
    },
  ])("$label -> $expected", ({ settings, expected }) => {
    expect(isCopilotAcpSettings(settings)).toBe(expected);
  });
});

describe("leadingCopilotSkillMention", () => {
  it.each([
    { text: "$deploy ship it", mention: { name: "deploy", rest: " ship it" } },
    { text: "  $deploy\nship it", mention: { name: "deploy", rest: "\nship it" } },
    { text: "  €deploy\nship it", mention: { name: "deploy", rest: "\nship it" } },
    { text: "$deploy", mention: { name: "deploy", rest: "" } },
    { text: "please run $deploy", mention: undefined },
    { text: "$25 off", mention: undefined },
    { text: "$deploy, then ship", mention: undefined },
    { text: "plain prompt without skills", mention: undefined },
  ])("reads $text", ({ text, mention }) => {
    assert.deepEqual(leadingCopilotSkillMention(text), mention);
  });
});

describe("decodeCopilotSkillList", () => {
  it("normalizes scopes, trims fields, keeps disabled skills, and sorts alphabetically", () => {
    const stdout = JSON.stringify([
      {
        name: "  writing-docs ",
        description: "  Write Greendale docs. ",
        source: "personal-agents",
        path: " /home/troy/.agents/skills/writing-docs/SKILL.md ",
        enabled: true,
      },
      {
        name: "deploy",
        description: "Deploy the study group app.",
        source: "project",
        path: "/workspaces/greendale/.github/skills/deploy/SKILL.md",
        enabled: true,
      },
      {
        name: "core-helper",
        description: "Built-in Copilot helper.",
        source: "builtin",
        path: "/opt/copilot/skills/core-helper/SKILL.md",
        enabled: false,
      },
      {
        name: "personal-notes",
        source: "PERSONAL",
        path: "/home/troy/.copilot/skills/personal-notes/SKILL.md",
      },
      {
        name: "acme-plugin",
        description: "  ",
        source: "  plugin  ",
        path: "/home/troy/.copilot/plugins/acme/SKILL.md",
        enabled: true,
      },
    ]);

    expect(decodeCopilotSkillList(stdout)).toEqual([
      {
        name: "acme-plugin",
        path: "/home/troy/.copilot/plugins/acme/SKILL.md",
        scope: "plugin",
        enabled: true,
      },
      {
        name: "core-helper",
        description: "Built-in Copilot helper.",
        path: "/opt/copilot/skills/core-helper/SKILL.md",
        scope: "system",
        enabled: false,
      },
      {
        name: "deploy",
        description: "Deploy the study group app.",
        path: "/workspaces/greendale/.github/skills/deploy/SKILL.md",
        scope: "project",
        enabled: true,
      },
      {
        name: "personal-notes",
        path: "/home/troy/.copilot/skills/personal-notes/SKILL.md",
        scope: "personal",
        enabled: true,
      },
      {
        name: "writing-docs",
        description: "Write Greendale docs.",
        path: "/home/troy/.agents/skills/writing-docs/SKILL.md",
        scope: "personal",
        enabled: true,
      },
    ]);
  });

  it("deduplicates by name keeping the first entry for project > personal > builtin precedence", () => {
    const stdout = JSON.stringify([
      {
        name: "review",
        description: "Project review skill",
        source: "project",
        path: "/workspaces/greendale/.github/skills/review/SKILL.md",
        enabled: true,
      },
      {
        name: "review",
        description: "Personal review skill",
        source: "personal",
        path: "/home/troy/.copilot/skills/review/SKILL.md",
        enabled: true,
      },
      {
        name: "review",
        description: "Builtin review skill",
        source: "builtin",
        path: "/opt/copilot/skills/review/SKILL.md",
        enabled: false,
      },
    ]);

    expect(decodeCopilotSkillList(stdout)).toEqual([
      {
        name: "review",
        description: "Project review skill",
        path: "/workspaces/greendale/.github/skills/review/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ]);
  });

  it("skips malformed entries missing a non-empty name or path", () => {
    const stdout = JSON.stringify([
      null,
      "not-an-object",
      { name: "   ", path: "/tmp/a/SKILL.md" },
      { name: "missing-path" },
      { name: "blank-path", path: "   " },
      { name: 42, path: "/tmp/b/SKILL.md" },
      {
        name: "kept",
        path: "/workspaces/greendale/.github/skills/kept/SKILL.md",
        source: "project",
      },
    ]);

    expect(decodeCopilotSkillList(stdout)).toEqual([
      {
        name: "kept",
        path: "/workspaces/greendale/.github/skills/kept/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ]);
  });

  it("returns undefined for malformed JSON or non-array payloads", () => {
    for (const stdout of ["not json", "null", "{}", '"array"', "42"]) {
      expect(decodeCopilotSkillList(stdout)).toBeUndefined();
    }
  });
});

describe("filterCopilotSlashCommands and applyCopilotDiscoveredSkills", () => {
  const slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [
    { name: "compact", description: "Compact context" },
    {
      name: "Deploy",
      description: "Deploy skill echoed as slash command",
      input: { hint: "instructions for the skill" },
    },
    {
      name: "  review ",
      description: "Review skill echoed as slash command",
      input: { hint: "instructions for the skill" },
    },
    { name: "plan", description: "Create a plan", input: { hint: "prompt" } },
    { name: "env", description: "Show environment" },
    { name: "help", description: "Show help" },
  ];
  const skills: ReadonlyArray<ServerProviderSkill> = [
    {
      name: "deploy",
      path: "/workspaces/greendale/.github/skills/deploy",
      scope: "project",
      enabled: true,
    },
    {
      name: "REVIEW",
      path: "/home/troy/.copilot/skills/review",
      scope: "personal",
      enabled: false,
    },
    {
      name: "plan",
      path: "/workspaces/greendale/.github/skills/plan",
      scope: "project",
      enabled: true,
    },
    {
      name: "env",
      path: "/workspaces/greendale/.github/skills/env",
      scope: "project",
      enabled: true,
    },
  ];

  it("drops all skill-hinted slash commands while preserving built-ins", () => {
    expect(filterCopilotSlashCommands(slashCommands)).toEqual([
      { name: "compact", description: "Compact context" },
      { name: "plan", description: "Create a plan", input: { hint: "prompt" } },
      { name: "env", description: "Show environment" },
      { name: "help", description: "Show help" },
    ]);
  });

  it("matches only session-advertised skill commands without matching built-ins", () => {
    expect(isCopilotAdvertisedSkill("deploy", slashCommands)).toBe(true);
    expect(isCopilotAdvertisedSkill("review", slashCommands)).toBe(true);
    expect(isCopilotAdvertisedSkill("plan", slashCommands)).toBe(false);
    expect(isCopilotAdvertisedSkill("env", slashCommands)).toBe(false);
    expect(isCopilotAdvertisedSkill("unknown", slashCommands)).toBe(false);
  });

  it("marks skills colliding with built-in slash commands as non-user-invocable", () => {
    const updated = applyCopilotDiscoveredSkills(makeProviderSnapshot({ slashCommands }), skills);

    expect(updated.skills).toEqual([
      skills[0],
      skills[1],
      { ...skills[2]!, userInvocable: false },
      { ...skills[3]!, userInvocable: false },
    ]);
  });
});

describe("discoverCopilotSkills", () => {
  const copilotSettings = decodeSettings({
    source: "registry",
    agentId: "github-copilot-cli",
  });

  it.effect(
    "resolves copilot, runs skill list --json with probe env and cwd, and decodes skills",
    () => {
      const resolveCalls: Array<{
        readonly settings: AcpRegistrySettings;
        readonly cwd: string;
        readonly environment: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawns: Array<RecordedSpawn> = [];
      const callerEnvironment = { COPILOT_HOME: "/home/troy/.copilot" };
      const resolvedEnv = {
        COPILOT_HOME: "/home/troy/.copilot",
        MISE_OFFLINE: "1",
        COPILOT_EXTRA: "from-distribution",
      };
      const stdout = JSON.stringify([
        {
          name: "writing-docs",
          description: "Write docs.",
          source: "personal-agents",
          path: "/home/troy/.agents/skills/writing-docs/SKILL.md",
          enabled: true,
        },
        {
          name: "deploy",
          description: "Deploy app.",
          source: "project",
          path: "/workspaces/greendale/.github/skills/deploy/SKILL.md",
          enabled: true,
        },
      ]);

      return Effect.gen(function* () {
        const skills = yield* discoverCopilotSkills({
          settings: copilotSettings,
          environment: callerEnvironment,
          cwd: "/workspaces/greendale",
        });

        expect(resolveCalls).toEqual([
          {
            settings: copilotSettings,
            cwd: "/workspaces/greendale",
            environment: {
              COPILOT_HOME: "/home/troy/.copilot",
              MISE_OFFLINE: "1",
            },
          },
        ]);
        expect(callerEnvironment).toEqual({ COPILOT_HOME: "/home/troy/.copilot" });
        expect(spawns).toHaveLength(1);
        expect(spawns[0]).toMatchObject({
          command: "/opt/copilot/bin/copilot",
          args: ["skill", "list", "--json"],
          options: {
            cwd: "/workspaces/greendale",
            env: resolvedEnv,
          },
        });
        expect(skills).toEqual([
          {
            name: "deploy",
            description: "Deploy app.",
            path: "/workspaces/greendale/.github/skills/deploy/SKILL.md",
            scope: "project",
            enabled: true,
          },
          {
            name: "writing-docs",
            description: "Write docs.",
            path: "/home/troy/.agents/skills/writing-docs/SKILL.md",
            scope: "personal",
            enabled: true,
          },
        ]);
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          makeResolvedCatalog({
            command: "/opt/copilot/bin/copilot",
            env: resolvedEnv,
            calls: resolveCalls,
          }),
        ),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner({ stdout, spawns }),
        ),
      );
    },
  );

  it.effect("omits cwd from spawn options when cwd is undefined", () => {
    const spawns: Array<RecordedSpawn> = [];
    return Effect.gen(function* () {
      const skills = yield* discoverCopilotSkills({ settings: copilotSettings });
      expect(skills).toEqual([]);
      expect(spawns[0]?.options?.cwd).toBeUndefined();
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, makeResolvedCatalog({})),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeSpawner({ stdout: "[]", spawns }),
      ),
    );
  });

  it.effect("maps catalog resolve failures to CopilotSkillsProbeError at resolve stage", () =>
    Effect.gen(function* () {
      const resolveError = new AcpRegistrySupport.AcpRegistryError({
        reason: "runner_unavailable",
        detail: "secret-path-not-in-message",
      });
      const error = yield* discoverCopilotSkills({
        settings: copilotSettings,
        cwd: "/workspaces/greendale",
      }).pipe(
        Effect.flip,
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          makeCatalog(() => Effect.fail(resolveError)),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeSpawner({})),
      );

      expect(error).toBeInstanceOf(CopilotSkillsProbeError);
      expect(error).toMatchObject({
        _tag: "CopilotSkillsProbeError",
        stage: "resolve",
        cwd: "/workspaces/greendale",
        cause: resolveError,
      });
      expect(error.message).not.toContain("secret-path-not-in-message");
    }),
  );

  it.effect("maps process spawn failures to CopilotSkillsProbeError at spawn stage", () =>
    Effect.gen(function* () {
      const error = yield* discoverCopilotSkills({
        settings: copilotSettings,
        cwd: "/workspaces/greendale",
      }).pipe(
        Effect.flip,
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, makeResolvedCatalog({})),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner({ failSpawn: true }),
        ),
      );

      expect(error).toMatchObject({
        _tag: "CopilotSkillsProbeError",
        stage: "spawn",
        cwd: "/workspaces/greendale",
      });
      expect(error.cause).toBeDefined();
    }),
  );

  it.effect("maps non-zero exit codes to CopilotSkillsProbeError at exit stage", () =>
    Effect.gen(function* () {
      const error = yield* discoverCopilotSkills({
        settings: copilotSettings,
        cwd: "/workspaces/greendale",
      }).pipe(
        Effect.flip,
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, makeResolvedCatalog({})),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner({ stdout: "[]", exitCode: 2 }),
        ),
      );

      expect(error).toMatchObject({
        _tag: "CopilotSkillsProbeError",
        stage: "exit",
        cwd: "/workspaces/greendale",
        exitCode: 2,
      });
      expect(error.message).toContain("exit code 2");
    }),
  );

  it.effect("maps invalid JSON stdout to CopilotSkillsProbeError at decode stage", () =>
    Effect.gen(function* () {
      const error = yield* discoverCopilotSkills({
        settings: copilotSettings,
        cwd: "/workspaces/greendale",
      }).pipe(
        Effect.flip,
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, makeResolvedCatalog({})),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner({ stdout: "{not valid json" }),
        ),
      );

      expect(error).toMatchObject({
        _tag: "CopilotSkillsProbeError",
        stage: "decode",
        cwd: "/workspaces/greendale",
      });
      expect(error.message).not.toContain("{not valid json");
    }),
  );

  it.effect("times out a hung probe after the deadline via TestClock", () =>
    Effect.gen(function* () {
      const probe = yield* discoverCopilotSkills({
        settings: copilotSettings,
        cwd: "/workspaces/greendale",
      }).pipe(
        Effect.flip,
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, makeResolvedCatalog({})),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeSpawner({ hang: true })),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust("4 seconds");

      const error = yield* Fiber.join(probe);
      expect(error).toMatchObject({
        _tag: "CopilotSkillsProbeError",
        stage: "timeout",
        cwd: "/workspaces/greendale",
      });
    }),
  );

  it.effect(
    "parses top-level YAML user-invocable: false across BOM, quoted keys, nested metadata, descriptions, and .md directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copilot-skills-" });
        const fixtures = [
          {
            name: "hidden-skill",
            dir: "hidden-skill",
            source: "builtin",
            content: "---\nname: hidden-skill\nuser-invocable: false\n---\nHidden instructions.\n",
          },
          {
            name: "bom-quoted-hidden",
            dir: "bom-quoted-hidden.md",
            source: "project",
            content:
              '\uFEFF---\nname: bom-quoted-hidden\n"user-invocable": false\n---\nHidden with BOM and quoted key.\n',
          },
          {
            name: "nested-visible",
            dir: "nested-visible",
            source: "project",
            content:
              "---\nname: nested-visible\ndescription: |\n  example:\n  user-invocable: false\nmetadata:\n  user-invocable: false\n---\nVisible instructions.\n",
          },
          {
            name: "visible-skill",
            dir: "visible-skill",
            source: "project",
            content: "---\nname: visible-skill\nuser-invocable: true\n---\nVisible instructions.\n",
          },
        ] as const;

        const payload = [];
        for (const fixture of fixtures) {
          const skillDir = path.join(tempDir, fixture.dir);
          yield* fs.makeDirectory(skillDir, { recursive: true });
          yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), fixture.content);
          payload.push({
            name: fixture.name,
            description: fixture.name,
            source: fixture.source,
            path: skillDir,
            enabled: true,
          });
        }

        const skills = yield* discoverCopilotSkills({
          settings: copilotSettings,
          cwd: tempDir,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, makeResolvedCatalog({})),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner({ stdout: JSON.stringify(payload) }),
          ),
        );

        expect(
          skills.map((skill) => ({
            name: skill.name,
            scope: skill.scope,
            userInvocable: skill.userInvocable,
          })),
        ).toEqual([
          { name: "bom-quoted-hidden", scope: "project", userInvocable: false },
          { name: "hidden-skill", scope: "system", userInvocable: false },
          { name: "nested-visible", scope: "project", userInvocable: undefined },
          { name: "visible-skill", scope: "project", userInvocable: undefined },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
