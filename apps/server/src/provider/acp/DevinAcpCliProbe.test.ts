/**
 * Optional integration check against a real `devin acp` installation.
 * Enable with: T3_DEVIN_ACP_PROBE=1 vp test run DevinAcpCliProbe.test.ts
 *
 * The probe uses the current authenticated Devin CLI profile and performs one
 * minimal prompt. It is opt-in so normal test runs never consume Devin usage.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DevinSettings } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";
import { makeDevinAcpRuntime } from "./DevinAcpSupport.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const devinSettings = decodeDevinSettings({ permissionMode: "normal" });
const probeCwd = process.env.T3_DEVIN_ACP_PROBE_CWD?.trim() || process.cwd();

const makeProbeRuntime = (
  requestLogger?: Parameters<typeof makeDevinAcpRuntime>[0]["requestLogger"],
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* makeDevinAcpRuntime({
      devinSettings,
      environment: process.env,
      childProcessSpawner,
      cwd: probeCwd,
      clientInfo: { name: "t3-devin-probe", version: "0.0.0" },
      ...(requestLogger ? { requestLogger } : {}),
    });
  });

describe.runIf(process.env.T3_DEVIN_ACP_PROBE === "1")("Devin ACP CLI probe", () => {
  it.effect("receives every command advertised by the live ACP session", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "available_commands_update") {
          return Effect.void;
        }
        return Ref.set(
          commands,
          update.availableCommands.map((command) => command.name),
        );
      });

      yield* runtime.start();
      const availableCommands = yield* Ref.get(commands);
      expect(availableCommands).toContain("compact");
      expect(availableCommands).toContain("context");
      if (process.env.T3_DEVIN_ACP_PROBE_CWD) {
        expect(availableCommands).toContain("t3-hardening");
      }
    }).pipe(Effect.timeout(180_000), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts an authenticated session and streams a minimal response", () =>
    Effect.gen(function* () {
      const requestLifecycle: Array<string> = [];
      const runtime = yield* makeProbeRuntime((event) =>
        Effect.sync(() => {
          requestLifecycle.push(`${event.method}:${event.status}`);
        }),
      );
      const output = yield* Ref.make("");
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const text = update.content.text;
        return Ref.update(output, (current) => current + text);
      });

      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(started.sessionId.length).toBeGreaterThan(0);
      expect(
        started.sessionSetupResult.configOptions?.some(
          (option) => option.category === "model" || option.id === "model",
        ) ?? false,
      ).toBe(true);

      const result = yield* runtime.prompt({
        prompt: [{ type: "text", text: "Reply with exactly T3_DEVIN_ACP_OK" }],
      });

      expect(result.stopReason).not.toBe("cancelled");
      expect((yield* Ref.get(output)).trim()).toBe("T3_DEVIN_ACP_OK");
      expect(requestLifecycle.some((entry) => entry.startsWith("authenticate:"))).toBe(false);
    }).pipe(Effect.timeout(180_000), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("selects every advertised model without reauthenticating", () =>
    Effect.gen(function* () {
      const requestLifecycle: Array<string> = [];
      const runtime = yield* makeProbeRuntime((event) =>
        Effect.sync(() => {
          requestLifecycle.push(`${event.method}:${event.status}`);
        }),
      );

      yield* runtime.start();
      const configOptions = yield* runtime.getConfigOptions;
      const modelOption = configOptions.find(
        (option) =>
          option.type === "select" && (option.category === "model" || option.id === "model"),
      );
      expect(modelOption?.type).toBe("select");
      if (!modelOption || modelOption.type !== "select") {
        return;
      }

      const modelValues = [...new Set(collectSessionConfigOptionValues(modelOption))];
      const initialModel =
        typeof modelOption.currentValue === "string" ? modelOption.currentValue : undefined;
      expect(modelValues.length).toBeGreaterThan(1);

      for (const modelValue of modelValues) {
        yield* runtime.setModel(modelValue);
        const currentOptions = yield* runtime.getConfigOptions;
        const currentModel = currentOptions.find(
          (option) =>
            option.type === "select" && (option.category === "model" || option.id === "model"),
        );
        expect(currentModel?.currentValue).toBe(modelValue);
      }

      if (initialModel) {
        yield* runtime.setModel(initialModel);
      }
      expect(requestLifecycle.some((entry) => entry.startsWith("authenticate:"))).toBe(false);
      yield* Effect.logInfo(`T3_DEVIN_ALL_MODELS_OK count=${modelValues.length}`);
    }).pipe(Effect.timeout(600_000), Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe.runIf(process.env.T3_DEVIN_ACP_CONTEXT_PROBE === "1")(
  "Devin ACP paid context probe",
  () => {
    it.effect(
      "preserves context while switching across live model families",
      () =>
        Effect.gen(function* () {
          const runtime = yield* makeProbeRuntime();
          const output = yield* Ref.make("");
          yield* runtime.handleSessionUpdate((notification) => {
            const update = notification.update;
            if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
              return Effect.void;
            }
            const text = update.content.text;
            return Ref.update(output, (current) => current + text);
          });

          yield* runtime.start();
          const configOptions = yield* runtime.getConfigOptions;
          const modelOption = configOptions.find(
            (option) =>
              option.type === "select" && (option.category === "model" || option.id === "model"),
          );
          expect(modelOption?.type).toBe("select");
          if (!modelOption || modelOption.type !== "select") {
            return;
          }

          const modelValues = collectSessionConfigOptionValues(modelOption);
          const familyPatterns = [
            /^gpt-5-6-sol-medium$/,
            /^claude-opus-5-medium$/,
            /^gemini-3-7-flash-medium$/,
            /^grok-4-6-medium$/,
            /^kimi-k3-high$/,
            /^glm-5-2$/,
            /^deepseek-v4-flash-low$/,
            /^swe-1-7$/,
          ];
          const familyModels = familyPatterns.flatMap((pattern) => {
            const match = modelValues.find((value) => pattern.test(value));
            return match ? [match] : [];
          });
          expect(familyModels).toHaveLength(familyPatterns.length);

          const reliableModel = familyModels[0]!;
          yield* runtime.setModel(reliableModel);
          const sentinel = "T3-MID-CONTEXT-MODELS-7D4B";
          yield* runtime.prompt({
            prompt: [
              {
                type: "text",
                text: `Remember ${sentinel} for this conversation and reply with exactly CONTEXT_SET`,
              },
            ],
          });
          yield* Effect.sleep("2 seconds");
          expect((yield* Ref.get(output)).trim()).toBe("CONTEXT_SET");

          for (const modelValue of familyModels.slice(1)) {
            yield* runtime.setModel(modelValue);
          }
          yield* runtime.setModel(reliableModel);

          yield* Ref.set(output, "");
          yield* runtime.prompt({
            prompt: [
              {
                type: "text",
                text: "Reply with exactly the conversation sentinel from the first user message.",
              },
            ],
          });
          yield* Effect.sleep("2 seconds");
          expect((yield* Ref.get(output)).trim()).toBe(sentinel);
          yield* Effect.logInfo(
            `T3_DEVIN_MID_CONTEXT_MODELS_OK count=${familyModels.length} sentinel=${sentinel}`,
          );
        }).pipe(Effect.timeout(300_000), Effect.scoped, Effect.provide(NodeServices.layer)),
      300_000,
    );
  },
);
