/**
 * Optional integration check against a real `agent acp` install.
 * Enable with: T3_CURSOR_ACP_PROBE=1 bun run test --filter CursorAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

describe.runIf(process.env.T3_CURSOR_ACP_PROBE === "1")("Cursor ACP CLI probe", () => {
  it.effect("initialize and authenticate against real agent acp", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: "agent",
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
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;
      console.log("session/new result:", JSON.stringify(result, null, 2));

      expect(typeof started.sessionId).toBe("string");

      const configOptions = result.configOptions;
      console.log("session/new configOptions:", JSON.stringify(configOptions, null, 2));

      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find((opt) => opt.category === "model");
        const parameterizedOptions = configOptions.filter(
          (opt) =>
            opt.category === "thought_level" ||
            opt.category === "model_option" ||
            opt.category === "model_config",
        );
        console.log("Model config option:", JSON.stringify(modelConfig, null, 2));
        console.log(
          "Parameterized model config options:",
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
            command: "agent",
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

  it.effect("session/set_config_option switches the model in-session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
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

      console.log("session/set_config_option result:", JSON.stringify(setResult, null, 2));

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
            command: "agent",
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
