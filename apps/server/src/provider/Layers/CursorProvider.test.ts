import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";
import { ProviderDriverKind, ProviderInstanceId, type CursorSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildCursorProviderSnapshot,
  buildCursorCapabilitiesFromConfigOptions,
  checkCursorProviderStatus,
  discoverCursorModelsViaAcp,
  makeCursorModelDiscovery,
  makeCursorCommandCatalog,
  getCursorParameterizedModelPickerUnsupportedMessage,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "./CursorProvider.ts";
import {
  discoverCursorSkills,
  hasCursorSkillMention,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "../Drivers/CursorSkills.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./cursorUsageLimits.ts";

const runNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

// Closing the probe kills the agent with SIGTERM; Windows terminates the
// process instead, so the mock never sees a signal to log.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string, currentValue?: boolean) {
  return {
    id,
    label,
    type: "boolean" as const,
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (
  extraEnv?: Record<string, string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-mock-",
  });
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    env: extraEnv ?? {},
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
});

const makeMockAgentWithAboutWrapper = Effect.fn("makeMockAgentWithAboutWrapper")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-about-mock-",
  });
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    source: [
      'if (process.argv[2] === "about") {',
      '  process.stdout.write("CLI Version         2026.04.09-f2b0fcd\\n");',
      '  process.stdout.write("User Email          cursor@example.com\\n");',
      "  process.exit(0);",
      "}",
      execScriptSource({ scriptPath: mockAgentPath }),
    ].join("\n"),
  });
});

const waitForFileContent = Effect.fn("waitForFileContent")(function* (
  filePath: string,
  attempts = 40,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const content = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.catch(() => Effect.void));
    if (content !== undefined) {
      if (content.trim().length > 0) {
        return content;
      }
    }
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(`Timed out waiting for file content at ${filePath}`);
});

const makeProviderStatusEnvFixture = Effect.fn("makeProviderStatusEnvFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-status-env-",
  });
  return {
    requestLogPath: path.join(tempDir, "requests.ndjson"),
    wrapperPath: yield* makeMockAgentWithAboutWrapper(),
  };
});

const makeExitLogFixture = Effect.fn("makeExitLogFixture")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix,
  });
  const exitLogPath = path.join(tempDir, "exit.log");
  return {
    exitLogPath,
    wrapperPath: yield* makeMockAgentWrapper({
      T3_ACP_EXIT_LOG_PATH: exitLogPath,
    }),
  };
});

const parameterizedGpt54ConfigOptions = [
  {
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ name: "GPT-5.4", value: "gpt-5.4-medium-fast" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "medium",
    options: [
      { name: "None", value: "none" },
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Extra High", value: "extra-high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "select",
    currentValue: "272k",
    options: [
      { name: "272K", value: "272k" },
      { name: "1M", value: "1m" },
    ],
    category: "model_config",
    id: "context",
    name: "Context",
  },
  {
    type: "select",
    currentValue: "false",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const parameterizedClaudeConfigOptions = [
  {
    type: "select",
    currentValue: "claude-4.6-opus-high-thinking",
    options: [{ name: "Opus 4.6", value: "claude-4.6-opus-high-thinking" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "boolean",
    currentValue: true,
    category: "model_config",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const parameterizedClaudeModelOptionConfigOptions = [
  {
    type: "select",
    currentValue: "claude-opus-4-6",
    options: [{ name: "Opus 4.6", value: "claude-opus-4-6" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "select",
    currentValue: "max",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Max", value: "max" },
    ],
    category: "model_option",
    id: "effort",
    name: "Effort",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: ":icon-brain:", value: "true" },
    ],
    category: "model_config",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const baseCursorSettings: CursorSettings = {
  enabled: true,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
};
const cursorAcpDiscoveryFailedMessage = [
  "Cursor ACP model discovery failed.",
  "Cursor CLI setup may be incomplete; install or enable the Cursor CLI, restart T3 Code, and try again.",
  "See https://cursor.com/docs/cli/installation.",
  "Check server logs for ACP details.",
].join(" ");
const missingCursorBinaryPath = "/definitely/not/installed/t3-cursor-agent";
const cursorCliCommandMissingMessage = [
  `Cursor CLI command \`${missingCursorBinaryPath}\` was not found.`,
  `Install or enable the Cursor CLI, make sure \`${missingCursorBinaryPath}\` is on PATH, then restart T3 Code.`,
  "See https://cursor.com/docs/cli/installation.",
].join(" ");

describe("Cursor skills", () => {
  it("discovers recursive project skills with project precedence", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-home-",
        });
        const workspace = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-workspace-",
        });
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });

        yield* writeSkill(
          path.join(userHome, ".cursor", "skills"),
          "review",
          "---\ndescription: user review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills", "nested"),
          "review",
          "---\nname: Review changes\ndescription: project review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "internal",
          "---\nuser-invocable: false\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "oversized",
          "x".repeat(1_000_001),
        );
        yield* fileSystem.makeDirectory(path.join(userHome, ".codex"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(userHome, ".codex", "skills"),
          "not a directory",
        );

        const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "internal",
            path: path.join(workspace, ".cursor", "skills", "internal", "SKILL.md"),
            scope: "project",
            enabled: true,
            userInvocable: false,
          },
          {
            name: "oversized",
            path: path.join(workspace, ".cursor", "skills", "oversized", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
          {
            name: "review",
            displayName: "Review changes",
            description: "project review",
            path: path.join(workspace, ".agents", "skills", "nested", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));

  it("treats a symlinked skill outside the root as a package boundary", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-home-",
        });
        const workspace = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-workspace-",
        });
        const library = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-library-",
        });
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          directory: string,
          contents: string,
        ) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
        });

        // A skill package managed in a config repo and installed by symlink.
        // Its own SKILL.md must be discovered under the link name, but nothing
        // below the target may be walked.
        yield* writeSkill(path.join(library, "shared-review"), "---\ndescription: shared\n---\n");
        yield* writeSkill(path.join(library, "shared-review", "hidden"), "---\n---\n");
        const root = path.join(workspace, ".cursor", "skills");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* fileSystem.symlink(path.join(library, "shared-review"), path.join(root, "review"));

        const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "review",
            description: "shared",
            path: path.join(root, "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Success");
      }),
    ));

  it("rewrites only discovered skill mentions into Cursor slash invocations", () => {
    expect(hasCursorSkillMention("use $Review_Pr:V2 here")).toBe(true);
    expect(hasCursorSkillMention("please $review this")).toBe(true);
    expect(
      rewriteCursorSkillMentions("use $review, keep $HOME and 5$review", new Set(["review"])),
    ).toBe("use $review, keep $HOME and 5$review");
    expect(rewriteCursorSkillMentions("please $review this", new Set(["review"]))).toBe(
      "please /review this",
    );
  });

  it("rewrites currency-prefixed skill mentions into Cursor slash invocations", () => {
    const names = new Set(["review", "2spec", "20k", "100M", "1e6"]);
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(hasCursorSkillMention(`please ${symbol}review this`)).toBe(true);
      expect(hasCursorSkillMention(`please ${symbol}review this`)).toBe(true);
      expect(rewriteCursorSkillMentions(`${symbol}review then ${symbol}2spec this`, names)).toBe(
        "/review then /2spec this",
      );
      const money = `${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6`;
      expect(hasCursorSkillMention(money)).toBe(false);
      expect(rewriteCursorSkillMentions(money, names)).toBe(money);
      const prose = `5${symbol}review ${symbol}unknown`;
      expect(rewriteCursorSkillMentions(prose, names)).toBe(prose);
    }
  });

  it("detects and invokes digit-leading Cursor skills without rewriting money", () => {
    const names = new Set(["2spec", "20k", "100M", "1e6"]);
    // Repeated presence checks must not carry a global-regex cursor.
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(rewriteCursorSkillMentions("use $2spec here", names)).toBe("use /2spec here");
    expect(rewriteCursorSkillMentions("use $2spec here", new Set())).toBe("use $2spec here");
    for (const text of [
      "pay $20 tomorrow",
      "budget $20k here",
      "cost $100M total",
      "limit $1e6 here",
    ]) {
      expect(hasCursorSkillMention(text)).toBe(false);
      expect(rewriteCursorSkillMentions(text, names)).toBe(text);
    }
  });
});

describe("Cursor command catalog", () => {
  effectIt.effect(
    "publishes workspace commands without leaking them globally and retains them across refreshes",
    () =>
      Effect.gen(function* () {
        const base = {
          ...buildCursorProviderSnapshot({
            checkedAt: "2026-01-01T00:00:00.000Z",
            cursorSettings: baseCursorSettings,
            parsed: { version: null, status: "ready", auth: { status: "authenticated" } },
          }),
          instanceId: ProviderInstanceId.make("cursor-catalog"),
          driver: ProviderDriverKind.make("cursor"),
        };
        const catalog = yield* makeCursorCommandCatalog({
          getSnapshot: Effect.succeed(base),
          refresh: Effect.succeed(base),
          streamChanges: Stream.empty,
          resolveMaintenance: () => Effect.die("Not used"),
          applyUsageLimits: () => Effect.void,
        });
        const skills = [
          { name: "review", path: "/one/.cursor/skills/review/SKILL.md", enabled: true },
        ];
        const probedSkills = [
          { name: "explain", path: "/probed/.cursor/skills/explain/SKILL.md", enabled: true },
        ];
        yield* catalog.snapshotForCwd("/probed", probedSkills);
        yield* catalog.onAvailableCommands(
          [
            { name: "review", description: "Review changes", input: { hint: "target" } },
            { name: "compact", description: "Native duplicate" },
            { name: "review", description: "Duplicate" },
          ],
          "/one",
          skills,
        );
        yield* catalog.onAvailableCommands([{ name: "deploy", description: "Deploy" }], "/two", []);
        const reprobed = yield* catalog.snapshotForCwd("/one", skills);
        expect(reprobed.slashCommands.map((command) => command.name)).toEqual([
          "compact",
          "review",
        ]);
        const published = yield* catalog.snapshot.streamChanges.pipe(
          Stream.take(1),
          Stream.runCollect,
        );
        expect(published[0]?.slashCommands.map((command) => command.name)).toEqual(["compact"]);
        const refreshed = yield* catalog.snapshot.refresh;
        expect(
          refreshed.workspaceSnapshots?.find((entry) => entry.cwd === "/probed"),
        ).toMatchObject({
          slashCommands: [{ name: "compact" }],
          skills: probedSkills,
        });
        expect(refreshed.workspaceSnapshots?.find((entry) => entry.cwd === "/one")).toMatchObject({
          slashCommands: [
            { name: "compact" },
            { name: "review", description: "Review changes", input: { hint: "target" } },
          ],
          skills,
        });
        yield* catalog.onAvailableCommands([], "/one", skills);
        const updated = yield* catalog.snapshot.getSnapshot;
        expect(
          updated.workspaceSnapshots?.find((entry) => entry.cwd === "/probed")?.skills,
        ).toEqual(probedSkills);
        expect(
          updated.workspaceSnapshots
            ?.find((entry) => entry.cwd === "/one")
            ?.slashCommands.map((command) => command.name),
        ).toEqual(["compact"]);
        expect(
          updated.workspaceSnapshots
            ?.find((entry) => entry.cwd === "/two")
            ?.slashCommands.map((command) => command.name),
        ).toEqual(["compact", "deploy"]);
      }),
  );

  effectIt.effect("rebuilds changed workspace skills in one write and skips unchanged ones", () =>
    Effect.gen(function* () {
      const base = {
        ...buildCursorProviderSnapshot({
          checkedAt: "2026-01-01T00:00:00.000Z",
          cursorSettings: baseCursorSettings,
          parsed: { version: null, status: "ready", auth: { status: "authenticated" } },
        }),
        instanceId: ProviderInstanceId.make("cursor-catalog"),
        driver: ProviderDriverKind.make("cursor"),
      };
      const catalog = yield* makeCursorCommandCatalog({
        getSnapshot: Effect.succeed(base),
        refresh: Effect.succeed(base),
        streamChanges: Stream.empty,
        resolveMaintenance: () => Effect.die("Not used"),
        applyUsageLimits: () => Effect.void,
      });
      const oneSkills = [
        { name: "review", path: "/one/.cursor/skills/review/SKILL.md", enabled: true },
      ];
      const twoSkills = [
        { name: "deploy", path: "/two/.cursor/skills/deploy/SKILL.md", enabled: true },
      ];
      const installedSkill = {
        name: "installed",
        path: "/home/.cursor/skills/installed/SKILL.md",
        enabled: true,
      };
      yield* catalog.snapshotForCwd("/one", oneSkills);
      yield* catalog.snapshotForCwd("/two", twoSkills);
      const before = (yield* catalog.snapshot.getSnapshot).workspaceSnapshots;

      yield* catalog.updateWorkspaceSkills(
        new Map([
          ["/one", oneSkills],
          ["/two", twoSkills],
        ]),
      );
      expect((yield* catalog.snapshot.getSnapshot).workspaceSnapshots).toBe(before);

      yield* catalog.updateWorkspaceSkills(
        new Map([
          ["/one", [...oneSkills, installedSkill]],
          ["/two", twoSkills],
          ["/evicted", [installedSkill]],
        ]),
      );
      const after = (yield* catalog.snapshot.getSnapshot).workspaceSnapshots;
      expect(after?.map((entry) => [entry.cwd, entry.skills])).toEqual([
        ["/one", [...oneSkills, installedSkill]],
        ["/two", twoSkills],
      ]);
      expect(after?.[1]).toBe(before?.[1]);
    }),
  );
});

describe("buildCursorProviderSnapshot", () => {
  it("downgrades ready status to warning when ACP model discovery times out", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "ready",
          auth: { status: "authenticated", type: "Team", label: "Cursor Team Subscription" },
        },
        discoveryWarning: "Cursor ACP model discovery timed out after 15000ms.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Cursor ACP model discovery timed out after 15000ms.",
      models: [],
      supportsConversationRollback: false,
    });
  });

  it("preserves provider error state while appending discovery warnings", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: {
          ...baseCursorSettings,
          customModels: ["claude-sonnet-4-6"],
        },
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
        },
        discoveryWarning: cursorAcpDiscoveryFailedMessage,
      }),
    ).toMatchObject({
      status: "error",
      message: `Cursor Agent is not authenticated. Run \`agent login\` and try again. ${cursorAcpDiscoveryFailedMessage}`,
      models: [
        {
          slug: "claude-sonnet-4-6",
          isCustom: true,
        },
      ],
    });
  });
});

describe("buildCursorCapabilitiesFromConfigOptions", () => {
  it("derives model capabilities from parameterized Cursor ACP config options", () => {
    expect(buildCursorCapabilitiesFromConfigOptions(parameterizedGpt54ConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
          ]),
          selectDescriptor("contextWindow", "Context", [
            { id: "272k", label: "272K", isDefault: true },
            { id: "1m", label: "1M" },
          ]),
          booleanDescriptor("fastMode", "Fast", false),
        ],
      }),
    );
  });

  it("detects boolean thinking toggles from model_config options", () => {
    expect(buildCursorCapabilitiesFromConfigOptions(parameterizedClaudeConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
          ]),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });

  it("prefers the newer model_option effort control over legacy thought_level", () => {
    expect(
      buildCursorCapabilitiesFromConfigOptions(parameterizedClaudeModelOptionConfigOptions),
    ).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Effort", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "max", label: "Max", isDefault: true },
          ]),
          booleanDescriptor("fastMode", "Fast", true),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });
});

describe("checkCursorProviderStatus", () => {
  it("reports the install docs when the Cursor CLI command is missing", async () => {
    const provider = await runNode(
      checkCursorProviderStatus({
        enabled: true,
        binaryPath: missingCursorBinaryPath,
        apiEndpoint: "",
        customModels: [],
      }),
    );

    expect(provider).toMatchObject({
      installed: false,
      status: "error",
      auth: { status: "unknown" },
      message: cursorCliCommandMissingMessage,
    });
  });

  it("passes the injected environment to ACP model discovery", async () => {
    const { requestLogPath, wrapperPath } = await runNode(makeProviderStatusEnvFixture());

    const provider = await runNode(
      checkCursorProviderStatus(
        {
          enabled: true,
          binaryPath: wrapperPath,
          apiEndpoint: "",
          customModels: [],
        },
        {
          ...process.env,
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
      ),
    );

    expect(provider.models.map((model) => model.slug)).toEqual([
      "default",
      "composer-2",
      "gpt-5.4",
      "claude-opus-4-6",
    ]);
    await expect(runNode(waitForFileContent(requestLogPath))).resolves.toContain("initialize");
  });
});

describe("discoverCursorModelsViaAcp", () => {
  it("reuses successful discovery until the CLI version or account changes", async () => {
    await runNode(
      Effect.gen(function* () {
        const { requestLogPath, wrapperPath } = yield* makeProviderStatusEnvFixture();
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = {
          enabled: true,
          binaryPath: wrapperPath,
          apiEndpoint: "",
          customModels: [],
        };
        const { discover, invalidate } = yield* makeCursorModelDiscovery(settings, {
          ...process.env,
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        });
        const about = {
          version: "2026.08.11",
          auth: { status: "authenticated" as const, label: "first@example.test" },
        };
        const first = yield* discover(about);
        expect(first.length).toBeGreaterThan(0);
        yield* fileSystem.writeFileString(requestLogPath, "");
        expect(yield* discover(about)).toEqual(first);
        expect(yield* fileSystem.readFileString(requestLogPath)).toBe("");
        yield* invalidate;
        expect(yield* discover(about)).toEqual(first);
        expect(yield* fileSystem.readFileString(requestLogPath)).toContain("initialize");
        yield* fileSystem.writeFileString(requestLogPath, "");
        yield* discover({ ...about, version: "2026.08.12" });
        expect(yield* fileSystem.readFileString(requestLogPath)).toContain("initialize");
        yield* fileSystem.writeFileString(requestLogPath, "");
        yield* discover({
          version: "2026.08.12",
          auth: { ...about.auth, label: "second@example.test" },
        });
        expect(yield* fileSystem.readFileString(requestLogPath)).toContain("initialize");
      }),
    );
  });

  it("keeps the ACP probe runtime alive long enough to discover models", async () => {
    const wrapperPath = await runNode(makeMockAgentWrapper());

    const models = await runNode(
      discoverCursorModelsViaAcp({
        enabled: true,
        binaryPath: wrapperPath,
        apiEndpoint: "",
        customModels: [],
      }).pipe(Effect.scoped),
    );

    expect(models.map((model) => model.slug)).toEqual([
      "default",
      "composer-2",
      "gpt-5.4",
      "claude-opus-4-6",
    ]);
  });

  it.skipIf(windowsHost)("closes the ACP probe runtime after discovery completes", async () => {
    const { exitLogPath, wrapperPath } = await runNode(
      makeExitLogFixture("cursor-provider-exit-log-"),
    );

    await runNode(
      discoverCursorModelsViaAcp({
        enabled: true,
        binaryPath: wrapperPath,
        apiEndpoint: "",
        customModels: [],
      }),
    );

    const exitLog = await runNode(waitForFileContent(exitLogPath));
    expect(exitLog).toContain("SIGTERM");
  });
});

describe("parseCursorAboutOutput", () => {
  it("parses json about output and forwards subscription metadata", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "jmarminge@gmail.com",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "jmarminge@gmail.com",
        type: "Team",
        label: "Cursor Team Subscription",
      },
    });
  });

  it("treats json about output with a logged-out email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "Not logged in",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });

  it("treats json about output with a null email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: null,
          userEmail: null,
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });
});

describe("Cursor parameterized model picker preview gating", () => {
  it("parses Cursor CLI version dates from build versions", () => {
    expect(parseCursorVersionDate("2026.04.08-c4e73a3")).toBe(20260408);
    expect(parseCursorVersionDate("2026.04.09")).toBe(20260409);
    expect(parseCursorVersionDate("not-a-version")).toBeUndefined();
  });

  it("parses the Cursor CLI channel from cli-config.json", () => {
    expect(parseCursorCliConfigChannel('{ "channel": "lab" }')).toBe("lab");
    expect(parseCursorCliConfigChannel('{ "channel": "stable" }')).toBe("stable");
    expect(parseCursorCliConfigChannel('{ "version": 1 }')).toBeUndefined();
    expect(parseCursorCliConfigChannel("not-json")).toBeUndefined();
  });

  it("returns no warning when the preview requirements are met", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "lab",
      }),
    ).toBeUndefined();
  });

  it("explains when the Cursor Agent version is too old", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.07-c4e73a3",
        channel: "lab",
      }),
    ).toContain("too old");
  });

  it("explains when the Cursor Agent channel is not lab", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "stable",
      }),
    ).toContain("lab channel");
  });
});

describe("resolveCursorAcpBaseModelId", () => {
  it("drops bracket traits without rewriting raw ACP model ids", () => {
    expect(resolveCursorAcpBaseModelId("gpt-5.4[reasoning=medium,context=272k]")).toBe("gpt-5.4");
    expect(resolveCursorAcpBaseModelId("gpt-5.4-medium-fast")).toBe("gpt-5.4-medium-fast");
    expect(resolveCursorAcpBaseModelId("claude-4.6-opus-high-thinking")).toBe(
      "claude-4.6-opus-high-thinking",
    );
    expect(resolveCursorAcpBaseModelId("composer-2")).toBe("composer-2");
    expect(resolveCursorAcpBaseModelId("auto")).toBe("auto");
  });
});

describe("resolveCursorAcpConfigUpdates", () => {
  it("maps Cursor model options onto separate ACP config option updates", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedGpt54ConfigOptions, [
        { id: "reasoning", value: "xhigh" },
        { id: "fastMode", value: true },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toEqual([
      { configId: "reasoning", value: "extra-high" },
      { configId: "context", value: "1m" },
      { configId: "fast", value: "true" },
    ]);
  });

  it("maps boolean thinking toggles when the model exposes them separately", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedClaudeConfigOptions, [
        { id: "thinking", value: false },
      ]),
    ).toEqual([{ configId: "thinking", value: false }]);
  });

  it("maps explicit fastMode: false so the adapter can clear a prior fast selection", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedGpt54ConfigOptions, [
        { id: "fastMode", value: false },
      ]),
    ).toEqual([{ configId: "fast", value: "false" }]);
  });

  it("writes Cursor effort changes through the newer model_option config when available", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedClaudeModelOptionConfigOptions, [
        { id: "reasoning", value: "max" },
        { id: "thinking", value: false },
      ]),
    ).toEqual([
      { configId: "effort", value: "max" },
      { configId: "thinking", value: "false" },
    ]);
  });
});

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Monthly",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Monthly · Auto",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Monthly · API",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Monthly", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Monthly", usedPercent: 100 }]);
  });

  it("reads the instance's credentials and endpoint even when usage enabled is false", async () => {
    await runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(directory, "cursor"));
        yield* fs.writeFileString(
          path.join(directory, "cursor", "auth.json"),
          '{"accessToken":"instance-token"}',
        );
        const client = HttpClient.make((request) => {
          expect(request.url).toBe(
            "https://cursor.example/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          );
          expect(request.method).toBe("POST");
          expect(request.headers.authorization).toBe("Bearer instance-token");
          expect(request.headers["connect-protocol-version"]).toBe("1");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ enabled: false, planUsage: { totalPercentUsed: 42 } }),
            ),
          );
        });
        yield* fs.makeDirectory(path.join(directory, ".cursor"));
        yield* fs.writeFileString(
          path.join(directory, ".cursor", "auth.json"),
          '{"accessToken":"instance-token"}',
        );
        for (const platform of ["linux", "darwin"] as const) {
          const limits = yield* readCursorUsageLimits(
            { apiEndpoint: "https://cursor.example/" },
            { XDG_CONFIG_HOME: directory, HOME: directory, AGENT_CLI_CREDENTIAL_STORE: "file" },
          ).pipe(
            Effect.provideService(HostProcessPlatform, platform),
            Effect.provideService(HttpClient.HttpClient, client),
          );
          expect(limits.windows[0]?.usedPercent).toBe(42);
        }
      }).pipe(Effect.scoped),
    );
  });

  it("never reads stale files for keychain or memory logins, but accepts an explicit auth token", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      for (const token of [undefined, "explicit-token"]) {
        const limits = await runNode(
          readCursorUsageLimits(
            { apiEndpoint: "" },
            {
              AGENT_CLI_CREDENTIAL_STORE: platform === "linux" ? "memory" : "default",
              ...(token ? { CURSOR_AUTH_TOKEN: token } : {}),
            },
          ).pipe(
            Effect.provideService(HostProcessPlatform, platform),
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                readFileString: () => Effect.die("must not read an unrelated credential file"),
              }),
            ),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                expect(token).toBe("explicit-token");
                expect(request.headers.authorization).toBe("Bearer explicit-token");
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json({ planUsage: { totalPercentUsed: 10 } }),
                  ),
                );
              }),
            ),
          ),
        );
        if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
        else expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }
  });

  it("reports failed requests without exposing credentials or response bodies", async () => {
    const limits = await runNode(
      readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "private-token" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("private response", { status: 401 }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(limits.unavailable).toEqual({
      reason: "probeFailed",
      message: "Cursor could not read usage limits.",
    });
  });

  it("does not use a stored login for an explicit API key", async () => {
    const limits = await runNode(
      readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_API_KEY: "different-account" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not request usage")),
        ),
      ),
    );
    expect(limits.unavailable?.reason).toBe("unsupported");
  });
});
