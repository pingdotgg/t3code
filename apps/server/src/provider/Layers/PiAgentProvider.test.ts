import { PiAgentSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import type { PiRpcClient } from "../pi/PiRpcClient.ts";
import type { PiRpcCommand, PiRpcResponse } from "../pi/PiRpcProtocol.ts";
import {
  buildPiAgentModels,
  buildPiAgentSkills,
  buildPiAgentSlashCommands,
  checkPiAgentProviderStatus,
  discoverPiAgentCatalog,
  makePendingPiAgentProvider,
} from "./PiAgentProvider.ts";

const decodeSettings = Schema.decodeSync(PiAgentSettings);
const settings = decodeSettings({
  enabled: true,
  agentDir: "~/.pi/work",
  sessionDir: "~/.pi/sessions",
});

describe("Pi Agent provider", () => {
  it("normalizes dynamic models and marks the active model", () => {
    const models = buildPiAgentModels({
      response: {
        models: [
          { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
          { provider: "openai", id: "gpt-5", displayName: "GPT-5" },
          { provider: "unknown", id: "unknown", name: "No configured model" },
          { provider: "anthropic", id: "claude-sonnet", name: "Duplicate" },
        ],
      },
      state: { model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "high" },
      thinkingLevels: ["low", "medium", "high"],
    });

    expect(models).toHaveLength(2);
    expect(models[1]).toMatchObject({
      slug: "openai/gpt-5",
      name: "GPT-5",
      isDefault: true,
    });
    expect(models[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      currentValue: "high",
    });
  });

  it("preserves each model's advertised thinking levels", () => {
    const models = buildPiAgentModels({
      response: {
        models: [
          {
            provider: "cliproxyapi",
            id: "gpt-5.6-sol",
            name: "GPT 5.6 Sol",
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              low: "low",
              medium: "medium",
              high: "high",
              ultra: "ultra",
            },
          },
          {
            provider: "cliproxyapi",
            id: "gpt-5.6-terra",
            name: "GPT 5.6 Terra",
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              low: "low",
              medium: "medium",
              high: "high",
              ultra: "ultra",
            },
          },
          {
            provider: "cliproxyapi",
            id: "gpt-5.6-luna",
            name: "GPT 5.6 Luna",
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              low: "low",
              medium: "medium",
              high: "high",
              max: "max",
              ultra: null,
            },
          },
        ],
      },
      state: {
        model: { provider: "cliproxyapi", id: "gpt-5.6-sol" },
        thinkingLevel: "high",
      },
      thinkingLevels: ["low", "medium", "high", "ultra"],
    });

    const thinkingOptionIds = (model: (typeof models)[number] | undefined) =>
      model?.capabilities?.optionDescriptors?.flatMap((descriptor) =>
        descriptor.type === "select" && descriptor.id === "reasoningEffort"
          ? [descriptor.options.map((option) => option.id)]
          : [],
      )[0];
    expect(thinkingOptionIds(models[1])).toEqual(["low", "medium", "high", "ultra"]);
    expect(thinkingOptionIds(models[2])).toEqual(["low", "medium", "high", "max"]);
  });

  it("normalizes and deduplicates Pi extension commands", () => {
    expect(
      buildPiAgentSlashCommands({
        commands: [
          { name: "deploy", description: "Deploy the app", input: { hint: "environment" } },
          {
            name: "skill:html-communicator",
            description: "Create an HTML report",
            source: "skill",
            sourceInfo: {
              path: "/home/user/.pi/agent/skills/html-communicator/SKILL.md",
              scope: "user",
            },
          },
          { name: "deploy", description: "duplicate" },
          { command: "review", help: "Review changes" },
        ],
      }),
    ).toEqual([
      { name: "deploy", description: "Deploy the app", input: { hint: "environment" } },
      { name: "review", description: "Review changes" },
    ]);
  });

  it("publishes Pi manual skills separately from slash commands", () => {
    expect(
      buildPiAgentSkills({
        commands: [
          {
            name: "skill:html-communicator",
            description: "Create an HTML report",
            source: "skill",
            sourceInfo: {
              path: "/home/user/.pi/agent/skills/html-communicator/SKILL.md",
              scope: "user",
            },
          },
          { name: "deploy", description: "Deploy the app", source: "extension" },
          {
            name: "skill:missing-path",
            description: "Cannot be shown without its source path",
            source: "skill",
          },
        ],
      }),
    ).toEqual([
      {
        name: "html-communicator",
        description: "Create an HTML report",
        shortDescription: "Create an HTML report",
        path: "/home/user/.pi/agent/skills/html-communicator/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it.effect("discovers models, commands, and paths through one short-lived RPC client", () =>
    Effect.gen(function* () {
      const commands: PiRpcCommand[] = [];
      const response = (command: PiRpcCommand): PiRpcResponse => ({
        ...(command.id ? { id: command.id } : {}),
        type: "response",
        command: command.type,
        success: true,
        data:
          command.type === "get_state"
            ? { model: { provider: "mock", id: "model-1" } }
            : command.type === "get_available_models"
              ? { models: [{ provider: "mock", id: "model-1", name: "Mock" }] }
              : command.type === "get_available_thinking_levels"
                ? { levels: ["medium", "high"] }
                : {
                    commands: [
                      { name: "hello", description: "Say hello" },
                      {
                        name: "skill:report",
                        description: "Write a report",
                        source: "skill",
                        sourceInfo: { path: "/tmp/skills/report/SKILL.md", scope: "project" },
                      },
                    ],
                  },
      });
      const client: PiRpcClient = {
        request: (command) =>
          Effect.sync(() => commands.push(command)).pipe(Effect.map(() => response(command))),
        send: () => Effect.void,
        events: Stream.empty,
        awaitFailure: Effect.never,
        close: Effect.void,
      };
      const catalog = yield* discoverPiAgentCatalog(
        settings,
        "/tmp/project",
        {},
        {
          makeClient: (options) => {
            expect(options.binaryPath).toBe("pi");
            expect(options.args).toEqual([
              "--mode",
              "rpc",
              "--no-session",
              "--session-dir",
              expect.stringContaining("/.pi/sessions"),
            ]);
            expect(options.env?.PI_CODING_AGENT_DIR).toEqual(expect.stringContaining("/.pi/work"));
            return Effect.succeed(client);
          },
        },
      );
      expect(catalog.models[0]?.slug).toBe("mock/model-1");
      expect(catalog.slashCommands).toEqual([{ name: "hello", description: "Say hello" }]);
      expect(catalog.skills).toEqual([
        {
          name: "report",
          description: "Write a report",
          shortDescription: "Write a report",
          path: "/tmp/skills/report/SKILL.md",
          scope: "project",
          enabled: true,
        },
      ]);
      expect(commands).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes the full-access-only and unsupported text-generation metadata", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingPiAgentProvider(decodeSettings({}));
      expect(snapshot.showInteractionModeToggle).toBe(false);
      expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
      expect(snapshot.supportsConversationRollback).toBe(false);
      expect(snapshot.supportsTextGeneration).toBe(false);
    }),
  );

  it.effect("does not probe a disabled user-managed binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiAgentProviderStatus(
        decodeSettings({ enabled: false, binaryPath: "/does/not/exist" }),
        "/tmp/project",
        {},
      );
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
