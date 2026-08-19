import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  PluginCommandCatalog,
  PluginCommandInvokeInput,
  PluginCommandInvocationResult,
} from "./pluginCommands.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeCatalog = Schema.decodeUnknownEffect(PluginCommandCatalog);
const decodeInvokeInput = Schema.decodeUnknownSync(PluginCommandInvokeInput);
const decodeInvocationResult = Schema.decodeUnknownSync(PluginCommandInvocationResult);

describe("plugin command contracts", () => {
  it.effect("decodes a multi-surface command catalog", () =>
    Effect.gen(function* () {
      const catalog = yield* decodeCatalog({
        generation: 3,
        commands: [
          {
            id: "t3.runtime-status",
            label: "Check plugin runtime",
            description: "Verify that the environment plugin runtime is responding.",
            surfaces: ["web", "desktop", "mobile"],
          },
        ],
      });

      expect(catalog.generation).toBe(3);
      expect(catalog.commands[0]?.surfaces).toEqual(["web", "desktop", "mobile"]);
    }),
  );

  it.effect("rejects unknown command surfaces", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeCatalog({
          generation: 1,
          commands: [{ id: "acme.command", label: "Command", surfaces: ["server"] }],
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it("defines generation-bound invocation schemas", () => {
    expect(
      decodeInvokeInput({
        generation: 4,
        id: "acme.command",
      }),
    ).toEqual({ generation: 4, id: "acme.command" });
    expect(
      decodeInvocationResult({
        message: "Command completed.",
        tone: "success",
      }),
    ).toEqual({ message: "Command completed.", tone: "success" });
  });

  it("registers fixed list, invoke, and subscribe rpc methods", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginCommandsList)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginCommandsInvoke)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.subscribePluginCommands)).toBe(true);
  });
});
