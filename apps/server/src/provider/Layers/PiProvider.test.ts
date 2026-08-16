import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { PiRpcCommandError, PiRpcProtocolError, type PiRpcClient } from "../pi/PiRpcClient.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const assert: typeof NodeAssert = NodeAssert;
const settings = Schema.decodeSync(PiSettings)({ binaryPath: "fake-pi" });

const unusedClientMethods = {
  events: Stream.empty,
  getCommands: () => Effect.succeed({ commands: [] }),
  getSessionStats: () =>
    Effect.succeed({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }),
  setModel: () => Effect.die("unused"),
  setThinkingLevel: () => Effect.die("unused"),
  prompt: () => Effect.die("unused"),
  abort: () => Effect.die("unused"),
  respondToExtensionUi: () => Effect.die("unused"),
  close: () => Effect.void,
} satisfies Omit<PiRpcClient, "getAvailableModels" | "getState">;

it.effect("maps Pi RPC inventory into selectable models", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkPiProviderStatus(settings, { PI_TOKEN: "test" }, (options) =>
      Effect.succeed({
        ...unusedClientMethods,
        getState: () =>
          Effect.succeed({
            model: { provider: "openai compatible", id: "gpt/5", reasoning: true },
            thinkingLevel: "medium" as const,
          }),
        getAvailableModels: () =>
          Effect.succeed({
            models: [
              { provider: "openai compatible", id: "gpt/5", name: " GPT Five ", reasoning: true },
            ],
          }),
        getCommands: () =>
          Effect.succeed({
            commands: [
              {
                name: "mcp",
                description: "Show MCP server status",
                source: "extension" as const,
                sourceInfo: {
                  path: "/home/test/.pi/extensions/mcp.ts",
                  source: "auto",
                  scope: "user",
                  origin: "top-level",
                },
              },
              {
                name: "subagents",
                description: "List subagents",
                source: "extension" as const,
                sourceInfo: {
                  path: "/home/test/.pi/extensions/subagents.ts",
                  source: "auto",
                  scope: "user",
                  origin: "top-level",
                },
              },
              {
                name: "project-only",
                description: "Project command",
                source: "extension" as const,
                sourceInfo: {
                  path: "/workspace/.pi/extensions/project.ts",
                  source: "auto",
                  scope: "project",
                  origin: "top-level",
                },
              },
              {
                name: "skill:review",
                description: "Review changes",
                source: "skill" as const,
                sourceInfo: {
                  path: "/home/test/.pi/skills/review/SKILL.md",
                  source: "auto",
                  scope: "user",
                  origin: "top-level",
                },
              },
            ],
          }),
      } satisfies PiRpcClient).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.equal(options.command, "fake-pi");
            assert.equal(options.env?.PI_TOKEN, "test");
            assert.equal(options.args?.includes("--no-session"), true);
            for (const arg of [
              "--no-context-files",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
            ])
              assert.equal(options.args?.includes(arg), false);
          }),
        ),
      ),
    );

    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.auth.status, "authenticated");
    assert.equal(snapshot.models[0]?.slug, "openai%20compatible/gpt%2F5");
    assert.equal(snapshot.models[0]?.name, "GPT Five");
    assert.equal(snapshot.models[0]?.isDefault, true);
    assert.equal(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]?.id, "thinkingLevel");
    assert.equal(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]?.currentValue, "medium");
    assert.match(snapshot.message ?? "", /MCP support is available/u);
    assert.deepEqual(snapshot.slashCommands, [
      { name: "mcp", description: "Show MCP server status" },
      { name: "subagents", description: "List subagents" },
      { name: "skill:review", description: "Review changes" },
    ]);
    assert.deepEqual(snapshot.skills, [
      {
        name: "review",
        description: "Review changes",
        shortDescription: "Review changes",
        path: "/home/test/.pi/skills/review/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a binary missing error wrapped by the Pi RPC protocol as not installed", () =>
  Effect.gen(function* () {
    const missing = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
    });
    const snapshot = yield* checkPiProviderStatus(settings, {}, () =>
      Effect.fail(new PiRpcProtocolError({ detail: "failed to spawn Pi RPC", cause: missing })),
    );

    assert.equal(snapshot.installed, false);
    assert.equal(snapshot.status, "error");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports discovery failure and does not spawn while disabled", () =>
  Effect.gen(function* () {
    let spawns = 0;
    const factory = () => {
      spawns += 1;
      return Effect.fail(
        new PiRpcCommandError({ command: "spawn", requestId: "test", detail: "inventory down" }),
      );
    };
    const failed = yield* checkPiProviderStatus(settings, {}, factory);
    assert.equal(failed.status, "error");
    assert.match(failed.message ?? "", /^Pi model discovery failed:/);

    const disabled = yield* checkPiProviderStatus({ ...settings, enabled: false }, {}, factory);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.status, "disabled");
    assert.match(disabled.message ?? "", /disabled/);
    assert.equal(spawns, 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);
