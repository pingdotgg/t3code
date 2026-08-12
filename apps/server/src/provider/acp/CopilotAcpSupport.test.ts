import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyCopilotSessionConfiguration,
  buildCopilotAcpSpawnInput,
  COPILOT_AUTH_METHOD_ID,
  resolveCopilotModeId,
  resolveCopilotModelId,
} from "./CopilotAcpSupport.ts";

describe("CopilotAcpSupport", () => {
  it("uses the authentication method advertised by the official CLI", () => {
    expect(COPILOT_AUTH_METHOD_ID).toBe("copilot-login");
  });

  it("builds the official Copilot ACP stdio launch and preserves environment", () => {
    const spawn = buildCopilotAcpSpawnInput(
      { binaryPath: "/usr/local/bin/copilot" },
      "/tmp/project",
      {
        COPILOT_GITHUB_TOKEN: "secret",
        COPILOT_HOME: "/tmp/copilot-home",
      },
    );
    expect(spawn).toEqual({
      command: "/usr/local/bin/copilot",
      args: ["--acp", "--stdio", "--no-auto-update"],
      cwd: "/tmp/project",
      env: {
        COPILOT_GITHUB_TOKEN: "secret",
        COPILOT_HOME: "/tmp/copilot-home",
      },
    });
  });

  it("normalizes model ids and keeps Copilot in Agent mode", () => {
    expect(resolveCopilotModelId("  gpt-5.4  ")).toBe("gpt-5.4");
    expect(resolveCopilotModelId(undefined)).toBe("auto");
    const modeState = {
      currentModeId: "agent",
      availableModes: [
        { id: "agent", name: "Agent" },
        { id: "plan", name: "Plan" },
        { id: "autopilot", name: "Autopilot" },
      ],
    };
    expect(
      resolveCopilotModeId({
        modeState,
        interactionMode: "plan",
        runtimeMode: "approval-required",
      }),
    ).toBe("agent");
    expect(
      resolveCopilotModeId({
        modeState,
        interactionMode: "default",
        runtimeMode: "approval-required",
      }),
    ).toBe("agent");
    expect(
      resolveCopilotModeId({
        modeState,
        interactionMode: "default",
        runtimeMode: "full-access",
      }),
    ).toBe("agent");
  });

  it.effect("sets model and reasoning effort without mutating allow_all", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      yield* applyCopilotSessionConfiguration({
        runtime: {
          getConfigOptions: Effect.succeed([
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5",
              options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning effort",
              type: "select",
              currentValue: "medium",
              options: [{ value: "high", name: "High" }],
            },
            {
              id: "allow_all",
              name: "Allow all",
              type: "boolean",
              currentValue: false,
            },
          ]),
          setModel: (model) =>
            Effect.sync(() => {
              calls.push(["model", model]);
            }),
          setConfigOption: (id, value) =>
            Effect.sync(() => {
              calls.push([id, value]);
              return { configOptions: [] };
            }),
        },
        model: "gpt-5.4",
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: (context) => context.cause,
      });
      expect(calls).toEqual([
        ["model", "gpt-5.4"],
        ["reasoning_effort", "high"],
      ]);
    }),
  );

  it.effect("resets a resumed concrete model to the negotiated automatic model", () =>
    Effect.gen(function* () {
      const models: Array<string> = [];
      yield* applyCopilotSessionConfiguration({
        runtime: {
          getConfigOptions: Effect.succeed([
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5.4",
              options: [
                { value: "default", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
              ],
            },
          ]),
          setModel: (model) =>
            Effect.sync(() => {
              models.push(model);
            }),
          setConfigOption: () => Effect.succeed({ configOptions: [] }),
        },
        model: "auto",
        selections: [],
        mapError: (context) => context.cause,
      });
      expect(models).toEqual(["default"]);
    }),
  );

  it.effect("refreshes model-dependent options before applying reasoning effort", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string]> = [];
      let modelConfigured = false;
      yield* applyCopilotSessionConfiguration({
        runtime: {
          getConfigOptions: Effect.sync(() =>
            modelConfigured
              ? [
                  {
                    id: "reasoning_effort",
                    name: "Reasoning effort",
                    type: "select" as const,
                    currentValue: "medium",
                    options: [{ value: "high", name: "High" }],
                  },
                ]
              : [
                  {
                    id: "model",
                    name: "Model",
                    type: "select" as const,
                    currentValue: "default",
                    options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
                  },
                ],
          ),
          setModel: (model) =>
            Effect.sync(() => {
              calls.push(["model", model]);
              modelConfigured = true;
            }),
          setConfigOption: (id, value) =>
            Effect.sync(() => {
              calls.push([id, String(value)]);
              return { configOptions: [] };
            }),
        },
        model: "gpt-5.4",
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: (context) => context.cause,
      });
      expect(calls).toEqual([
        ["model", "gpt-5.4"],
        ["reasoning_effort", "high"],
      ]);
    }),
  );
});
