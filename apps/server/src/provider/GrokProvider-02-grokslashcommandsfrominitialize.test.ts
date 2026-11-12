// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { GrokSettings } from "@t3tools/provider-grok/settings";

import {
  buildGrokModelCapabilities,
  checkGrokProviderStatus,
  grokSlashCommandsFromInitialize,
  parseGrokModelsCliOutput,
} from "@t3tools/provider-grok/testing";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { grokUsageResponseToLimits, readGrokAccount } from "@t3tools/provider-grok/testing";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
  "",
].join("\n");

const LOGGED_OUT_MODELS_OUTPUT = LOGGED_IN_MODELS_OUTPUT.replace(
  "You are logged in with grok.com.",
  "You are not authenticated.",
);









describe("grokSlashCommandsFromInitialize", () => {
  it("publishes native ACP commands and input hints without permission overrides", () => {
    const commands = grokSlashCommandsFromInitialize({
      protocolVersion: 1,
      _meta: {
        availableCommands: [
          { name: "compact", description: "Compress history", input: { hint: "what to preserve" } },
          {
            name: "always-approve",
            description: "Skip permission prompts",
            input: { hint: "on|off" },
          },
          { name: "context", description: "Show context usage", input: null },
          { name: "session-info", description: "Show session details" },
          { name: "deep-research", description: "Research a topic", input: { hint: "<query>" } },
          { name: "workflow", description: "Manage workflows", input: { hint: "runs" } },
          { name: "goal", description: "Manage an autonomous goal", input: { hint: "status" } },
        ],
      },
    });
    expect(commands.map((command) => command.name)).toEqual([
      "compact",
      "session-info",
      "deep-research",
      "workflow",
      "goal",
    ]);
    expect(commands[0]?.input).toEqual({ hint: "what to preserve" });
    expect(commands[2]).toEqual({
      name: "deep-research",
      description: "Research a topic",
      input: { hint: "<query>" },
    });
  });

  it("keeps valid commands when other metadata entries are malformed", () => {
    const commands = grokSlashCommandsFromInitialize({
      protocolVersion: 1,
      _meta: {
        availableCommands: [
          null,
          { name: "broken", description: 42 },
          { name: " ", description: "Empty name" },
          { name: " session-info ", description: " Session details " },
          { name: "session-info", description: "Updated session details" },
        ],
      },
    });
    expect(commands.map((command) => command.name)).toEqual(["compact", "session-info"]);
    expect(commands[1]?.description).toBe("Updated session details");
  });
});

