/**
 * Optional integration check against a real `cursor-agent acp` install.
 * Enable with: T3_CURSOR_ACP_PROBE=1 bun run test --filter CursorAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

describe.runIf(process.env.T3_CURSOR_ACP_PROBE === "1")("Cursor ACP CLI probe", () => {
  it.effect("initialize and authenticate against real cursor-agent acp", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "t3-probe", version: "0.0.0" },
          authMethodId: "cursor_login",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("session/new returns configOptions with a model selector", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      yield* Console.log("session/new result:", JSON.stringify(result, null, 2));

      expect(typeof started.sessionId).toBe("string");

      const configOptions = result.configOptions;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      yield* Console.log("session/new configOptions:", JSON.stringify(configOptions, null, 2));

      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find((opt) => opt.category === "model");
        const parameterizedOptions = configOptions.filter(
          (opt) =>
            opt.category === "thought_level" ||
            opt.category === "model_option" ||
            opt.category === "model_config",
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* Console.log("Model config option:", JSON.stringify(modelConfig, null, 2));
        yield* Console.log(
          "Parameterized model config options:",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify(parameterizedOptions, null, 2),
        );
        expect(modelConfig).toBeDefined();
        expect(typeof modelConfig?.id).toBe("string");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "cursor_login",
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "t3-probe", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  // Runs one real prompt that provokes a permission request and dumps the
  // agent-defined option ids, plus every session-update kind observed along
  // the way (usage_update, agent_thought_chunk, available_commands_update).
  // This is the ground truth behind selectAcpPermissionOptionId and the
  // token-usage / reasoning / slash-command parsing in AcpRuntimeModel.
  it.effect(
    "dumps permission options, modes, and session-update kinds from a real turn",
    () =>
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        const observedUpdateKinds = new Set<string>();
        yield* runtime.handleRequestPermission((params) =>
          Effect.gen(function* () {
            yield* Console.log(
              "session/request_permission options:",
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify(params.options, null, 2),
            );
            const rejectOption = params.options.find((option) => option.kind === "reject_once");
            return {
              outcome:
                rejectOption !== undefined
                  ? { outcome: "selected" as const, optionId: rejectOption.optionId }
                  : ({ outcome: "cancelled" } as const),
            };
          }),
        );
        const started = yield* runtime.start();
        yield* Console.log(
          "availableModes:",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify(started.sessionSetupResult.modes, null, 2),
        );

        yield* Stream.runForEach(runtime.getEvents(), (event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined)
            : Effect.sync(() => {
                observedUpdateKinds.add(event._tag);
              }),
        ).pipe(Effect.forkChild);

        yield* runtime.prompt({
          prompt: [
            {
              type: "text",
              text: "Run `ls` in the current directory, then reply with one word.",
            },
          ],
        });
        yield* runtime.drainEvents;
        yield* Console.log("observed parsed event tags:", [...observedUpdateKinds].join(", "));
        yield* Console.log(
          "available commands:",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify(yield* runtime.getAvailableCommands, null, 2),
        );
        expect(typeof started.sessionId).toBe("string");
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            authMethodId: "cursor_login",
            spawn: {
              command: "cursor-agent",
              args: ["acp"],
              cwd: process.cwd(),
            },
            cwd: process.cwd(),
            clientCapabilities: {
              _meta: {
                parameterizedModelPicker: true,
              },
            },
            clientInfo: { name: "t3-probe", version: "0.0.0" },
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    120_000,
  );

  it.effect("session/set_config_option switches the model in-session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      const newResult = started.sessionSetupResult;

      const configOptions = newResult.configOptions;
      let modelConfigId = "model";
      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find((opt) => opt.category === "model");
        if (typeof modelConfig?.id === "string") {
          modelConfigId = modelConfig.id;
        }
      }

      const setResult: EffectAcpSchema.SetSessionConfigOptionResponse =
        yield* runtime.setConfigOption(modelConfigId, "gpt-5.4");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      yield* Console.log("session/set_config_option result:", JSON.stringify(setResult, null, 2));

      if (Array.isArray(setResult.configOptions)) {
        const modelConfig = setResult.configOptions.find((opt) => opt.category === "model");
        const parameterizedOptions = setResult.configOptions.filter(
          (opt) =>
            opt.category === "thought_level" ||
            opt.category === "model_option" ||
            opt.category === "model_config",
        );
        if (modelConfig?.type === "select") {
          expect(modelConfig.currentValue).toBe("gpt-5.4");
        }
        expect(parameterizedOptions.length).toBeGreaterThan(0);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "cursor_login",
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "t3-probe", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
