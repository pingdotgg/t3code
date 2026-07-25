import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyHermesAcpSelection,
  applyHermesRuntimeMode,
  buildHermesAcpSpawnInput,
  resolveHermesAcpConfigUpdates,
  resolveHermesRequestedModelId,
} from "./HermesAcpSupport.ts";

describe("HermesAcpSupport", () => {
  it("spawns the Hermes ACP subcommand in the project cwd", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes/bin/hermes" }, "/workspace/project", {
        ANTHROPIC_API_KEY: "test-key",
      }),
    ).toEqual({
      command: "/opt/hermes/bin/hermes",
      args: ["acp"],
      cwd: "/workspace/project",
      env: { ANTHROPIC_API_KEY: "test-key" },
    });
  });

  it("treats the fallback model as Hermes' configured default", () => {
    expect(resolveHermesRequestedModelId("hermes-default")).toBeUndefined();
    expect(resolveHermesRequestedModelId("anthropic:claude-sonnet-5")).toBe(
      "anthropic:claude-sonnet-5",
    );
    expect(resolveHermesRequestedModelId("custom:vNext/model@2027")).toBe(
      "custom:vNext/model@2027",
    );
  });

  it.effect("selects the model before reading and applying its refreshed config catalog", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      const model = yield* applyHermesAcpSelection({
        runtime: {
          getConfigOptions: Effect.sync(() => {
            calls.push(["catalog", "refreshed"]);
            return [
              {
                id: "reasoning_effort",
                name: "Reasoning effort",
                type: "select",
                currentValue: "future/max",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "future/max", name: "Future Max" },
                ],
              },
              {
                id: "extended_context",
                name: "Extended context",
                type: "boolean",
                currentValue: false,
              },
            ];
          }),
          setSessionModel: (modelId) =>
            Effect.sync(() => {
              calls.push(["model", modelId]);
              return {};
            }),
          setConfigOption: (configId, value) =>
            Effect.sync(() => {
              calls.push([configId, value]);
              return { configOptions: [] };
            }),
        },
        currentModelId: "openrouter:old-model",
        selection: {
          model: "anthropic:claude-sonnet-5",
          options: [
            { id: "reasoning_effort", value: "future/max" },
            { id: "reasoning_effort", value: "not-advertised" },
            { id: "reasoning_effort", value: true },
            { id: "extended_context", value: true },
            { id: "extended_context", value: "true" },
            { id: "not_advertised", value: true },
          ],
        },
        mapError: ({ cause }) => cause,
      });

      expect(model).toBe("anthropic:claude-sonnet-5");
      expect(calls).toEqual([
        ["model", "anthropic:claude-sonnet-5"],
        ["catalog", "refreshed"],
        ["reasoning_effort", "future/max"],
        ["extended_context", true],
      ]);
    }),
  );

  it.effect("reselects an explicitly restored model before applying resumed options", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* applyHermesAcpSelection({
        runtime: {
          setSessionModel: (modelId) =>
            Effect.sync(() => {
              calls.push(`model:${modelId}`);
              return {};
            }),
          getConfigOptions: Effect.sync(() => {
            calls.push("catalog");
            return [
              {
                id: "reasoning_effort",
                name: "Reasoning effort",
                type: "select",
                currentValue: "medium",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
              },
            ];
          }),
          setConfigOption: (configId, value) =>
            Effect.sync(() => {
              calls.push(`config:${configId}:${String(value)}`);
              return { configOptions: [] };
            }),
        },
        currentModelId: "openrouter:model-vNext",
        selection: {
          model: "openrouter:model-vNext",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
        forceModelSelection: true,
        mapError: ({ cause }) => cause,
      });

      expect(calls).toEqual([
        "model:openrouter:model-vNext",
        "catalog",
        "config:reasoning_effort:high",
      ]);
    }),
  );

  it("suppresses stale and invalid selections against the advertised catalog", () => {
    expect(
      resolveHermesAcpConfigUpdates(
        [
          {
            id: "reasoning/vNext",
            name: "Reasoning vNext",
            type: "select",
            currentValue: "provider:auto",
            options: [
              { value: "provider:auto", name: "Provider auto" },
              { value: "future/max", name: "Future max" },
            ],
          },
          {
            id: "thinking.enabled",
            name: "Thinking enabled",
            type: "boolean",
            currentValue: true,
          },
        ],
        [
          { id: "reasoning/vNext", value: "future/max" },
          { id: "reasoning/vNext", value: "unknown" },
          { id: "reasoning/vNext", value: false },
          { id: "thinking.enabled", value: false },
          { id: "thinking.enabled", value: "false" },
          { id: "stale.option", value: true },
        ],
      ),
    ).toEqual([
      { configId: "reasoning/vNext", value: "future/max" },
      { configId: "thinking.enabled", value: false },
    ]);
  });

  it.effect("maps T3 runtime modes onto Hermes ACP modes", () =>
    Effect.gen(function* () {
      const modes: string[] = [];
      const runtime = {
        setSessionMode: (modeId: string) =>
          Effect.sync(() => {
            modes.push(modeId);
            return {};
          }),
      };
      for (const runtimeMode of [
        "approval-required",
        "auto-accept-edits",
        "full-access",
      ] as const) {
        yield* applyHermesRuntimeMode({
          runtime,
          runtimeMode,
          mapError: (cause) => cause,
        });
      }
      expect(modes).toEqual(["default", "accept_edits", "dont_ask"]);
    }),
  );
});
