/**
 * Optional integration check against a real `grok agent stdio` install.
 * Enable with: T3_GROK_ACP_PROBE=1 bun run test GrokAcpCliProbe
 *
 * The probe assumes either `XAI_API_KEY` is set in the environment or
 * the user has previously run `grok login`. Without credentials the
 * agent's `authenticate` request will fail and the test will surface
 * the error.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeGrokAcpRuntime } from "./GrokAcpSupport.ts";
import {
  makeXAiExitPlanModeApprovedResponse,
  unwrapExitPlanModeParams,
  XAiExitPlanModeRequest,
} from "./XAiAcpExtension.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeGrokAcpRuntime({
    grokSettings: { binaryPath: "grok" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_GROK_ACP_PROBE === "1")("Grok ACP CLI probe", () => {
  it.effect("initialize and authenticate against real grok agent stdio", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises typed SessionModelState with at least one model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;

      expect(typeof started.sessionId).toBe("string");

      // Modern grok-shell advertises models through the typed
      // `SessionModelState` field, not via a `configOptions` entry.
      // If this assertion fails the upstream surface has regressed.
      const models = result.models;
      expect(models).toBeDefined();
      expect(typeof models?.currentModelId).toBe("string");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_model accepts a no-op switch to the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      // No-op switch — selecting the model the session already runs on must
      // succeed against every Grok build that implements `session/set_model`.
      yield* runtime.setSessionModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session remains promptable after session/set_model (in-session continuity)", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      yield* runtime.setSessionModel(currentModelId);
      const result = yield* runtime.prompt({
        prompt: [
          {
            type: "text",
            text: "Reply with exactly one word: ok. Do not use tools.",
          },
        ],
      });
      expect(result.stopReason).toBeDefined();
      // Live wire currently advertises a single model; when more appear, the
      // same set_model path is used by applyGrokAcpModelSelection.
      const available = started.sessionSetupResult.models?.availableModels ?? [];
      expect(available.length).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("initialize _meta exposes reasoningEfforts, totalContextTokens, and commands", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const meta = started.initializeResult._meta as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      const modelState = meta?.modelState as
        | {
            readonly availableModels?: ReadonlyArray<{
              readonly _meta?: {
                readonly totalContextTokens?: number;
                readonly reasoningEfforts?: unknown;
              };
            }>;
          }
        | undefined;
      const firstMeta = modelState?.availableModels?.[0]?._meta;
      expect(firstMeta?.totalContextTokens).toBeGreaterThan(0);
      expect(Array.isArray(firstMeta?.reasoningEfforts)).toBe(true);
      expect((firstMeta?.reasoningEfforts as unknown[]).length).toBeGreaterThan(0);
      expect(Array.isArray(meta?.availableCommands)).toBe(true);
      expect((meta?.availableCommands as unknown[]).length).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("process-scoped --reasoning-effort is reflected in initialize model meta", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeGrokAcpRuntime({
        grokSettings: { binaryPath: "grok" },
        environment: process.env,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-grok-probe-effort", version: "0.0.0" },
        spawnOptions: { reasoningEffort: "low" },
      });
      const started = yield* runtime.start();
      const meta = started.initializeResult._meta as Record<string, unknown> | undefined;
      const modelState = meta?.modelState as
        | {
            readonly availableModels?: ReadonlyArray<{
              readonly _meta?: { readonly reasoningEffort?: string };
            }>;
          }
        | undefined;
      const effort = modelState?.availableModels?.[0]?._meta?.reasoningEffort;
      expect(effort).toBe("low");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_config_option is not advertised on live Grok configOptions", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const options = started.sessionSetupResult.configOptions ?? [];
      // Live Grok 0.2.x: effort is process-scoped CLI, not ACP config options.
      const effortOption = options.find((option) => {
        const id = option.id.trim().toLowerCase();
        const name = option.name.trim().toLowerCase();
        return (
          id.includes("reason") ||
          id.includes("effort") ||
          name.includes("reason") ||
          name.includes("effort")
        );
      });
      expect(effortOption).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("live agent can reverse-call _x.ai/exit_plan_mode and accept approved outcome", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const exitSeen = yield* Deferred.make<string>();

      yield* Effect.forEach(
        ["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"] as const,
        (method) =>
          runtime.handleExtRequest(method, XAiExitPlanModeRequest, (params) =>
            Effect.gen(function* () {
              const unwrapped = unwrapExitPlanModeParams(params);
              yield* Deferred.succeed(exitSeen, method).pipe(Effect.ignore);
              // Live agent accepts the approved outcome shape from XAiAcpExtension.
              return makeXAiExitPlanModeApprovedResponse();
            }),
          ),
        { discard: true },
      );

      const promptFiber = yield* runtime
        .prompt({
          prompt: [
            {
              type: "text",
              text: "Immediately call the x.ai/exit_plan_mode extension if available with any plan. If you cannot, reply ONLY with NO_EXIT_PLAN_TOOL.",
            },
          ],
        })
        .pipe(Effect.forkChild);

      const method = yield* Deferred.await(exitSeen).pipe(Effect.timeout("90 seconds"));
      expect(method.includes("exit_plan_mode")).toBe(true);

      const promptResult = yield* Fiber.join(promptFiber).pipe(Effect.timeout("90 seconds"));
      expect(promptResult.stopReason).toBeDefined();
      void started;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
