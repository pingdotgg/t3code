import * as NodeOS from "node:os";
import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { listCodexProviderSkills, mapCodexModelCapabilities } from "./CodexProvider.ts";
import { listCodexProviderSkillsWithTimeout } from "../ProviderSkillsLister.ts";

const resolveMockAppServerPath = Effect.fn("resolveMockAppServerPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(
    new URL("../../../scripts/codex-skills-mock-app-server.ts", import.meta.url),
  );
});

const makeMockAppServer = Effect.fn("makeMockAppServer")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAppServerPath = yield* resolveMockAppServerPath();
  const directory = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "codex-skills-provider-",
  });
  const binaryPath = path.join(directory, "codex");
  const command = [process.execPath, mockAppServerPath]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
  yield* fileSystem.writeFileString(binaryPath, `#!/bin/sh\nexec ${command} "$@"\n`);
  yield* fileSystem.chmod(binaryPath, 0o755);
  const workspaceDirectory = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "codex-skills-workspace-",
  });
  return {
    binaryPath,
    cwd: yield* fileSystem.realPath(workspaceDirectory),
    cwdLogPath: path.join(directory, "cwd.log"),
    exitLogPath: path.join(directory, "exit.log"),
  };
});

const waitForFileContent = Effect.fn("waitForFileContent")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const content = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (content.trim()) return content;
    yield* Effect.promise(() => NodeTimersPromises.setTimeout(50));
  }
  return yield* Effect.die(`Timed out waiting for file content at ${filePath}`);
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

describe("listCodexProviderSkills", () => {
  it.effect("lists workspace skills from the configured cwd", () =>
    Effect.gen(function* () {
      const fixture = yield* makeMockAppServer();
      const skills = yield* listCodexProviderSkills({
        binaryPath: fixture.binaryPath,
        cwd: fixture.cwd,
        environment: {
          ...process.env,
          T3_CODEX_CWD_LOG_PATH: fixture.cwdLogPath,
        },
      }).pipe(Effect.scoped);

      expect(skills).toEqual([
        {
          name: "workspace-skill",
          description: "A workspace-scoped test skill.",
          shortDescription: "Workspace test skill",
          path: `${fixture.cwd}/.agents/skills/workspace-skill/SKILL.md`,
          scope: "repo",
          enabled: true,
        },
      ]);
      expect((yield* waitForFileContent(fixture.cwdLogPath)).trim()).toBe(fixture.cwd);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports timeouts and terminates the app-server", () =>
    Effect.gen(function* () {
      const fixture = yield* makeMockAppServer();
      const fiber = yield* listCodexProviderSkillsWithTimeout({
        instanceId: ProviderInstanceId.make("codex"),
        binaryPath: fixture.binaryPath,
        cwd: fixture.cwd,
        environment: {
          ...process.env,
          T3_CODEX_CWD_LOG_PATH: fixture.cwdLogPath,
          T3_CODEX_EXIT_LOG_PATH: fixture.exitLogPath,
          T3_CODEX_HANG_SKILLS_LIST: "1",
        },
      }).pipe(Effect.forkChild);

      yield* waitForFileContent(fixture.cwdLogPath);
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.message).toBe(
        `Timed out listing Codex skills after 15s (provider: 'codex', cwd: '${fixture.cwd}').`,
      );
      expect(yield* waitForFileContent(fixture.exitLogPath)).toContain("SIGTERM");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
