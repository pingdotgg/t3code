import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyOmpAcpModelSelection,
  buildOmpAcpSpawnInput,
  ompAcpSpawnArgs,
  resolveOmpAcpBaseModelId,
} from "./OmpAcpSupport.ts";

const ompConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "zhipu-coding-plan/glm-5.3",
    options: [
      { value: "zhipu-coding-plan/glm-5.3", name: "GLM 5.3" },
      { value: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
      { value: "openai/gpt-5.4", name: "GPT-5.4" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

describe("ompAcpSpawnArgs", () => {
  it("maps runtime modes onto omp approval flags", () => {
    expect(ompAcpSpawnArgs(undefined)).toEqual(["acp", "--approval-mode=always-ask"]);
    expect(ompAcpSpawnArgs("approval-required")).toEqual(["acp", "--approval-mode=always-ask"]);
    expect(ompAcpSpawnArgs("auto-accept-edits")).toEqual(["acp", "--approval-mode=write"]);
    expect(ompAcpSpawnArgs("auto")).toEqual(["acp", "--auto-approve"]);
    expect(ompAcpSpawnArgs("full-access")).toEqual(["acp", "--approval-mode=yolo"]);
  });
});

describe("buildOmpAcpSpawnInput", () => {
  it("builds the default omp ACP command", () => {
    expect(buildOmpAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "omp",
      args: ["acp", "--approval-mode=always-ask"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary path and forwards the runtime mode", () => {
    expect(
      buildOmpAcpSpawnInput(
        { binaryPath: "/usr/local/bin/omp" },
        "/tmp/project",
        undefined,
        "full-access",
      ),
    ).toEqual({
      command: "/usr/local/bin/omp",
      args: ["acp", "--approval-mode=yolo"],
      cwd: "/tmp/project",
    });
  });

  it("passes the injected environment through without extra variables", () => {
    const environment = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    expect(buildOmpAcpSpawnInput(undefined, "/tmp/project", environment)).toEqual({
      command: "omp",
      args: ["acp", "--approval-mode=always-ask"],
      cwd: "/tmp/project",
      env: environment,
    });
  });
});

describe("resolveOmpAcpBaseModelId", () => {
  it("passes provider/model ids through and drops bracket traits", () => {
    expect(resolveOmpAcpBaseModelId("zhipu-coding-plan/glm-5.3")).toBe("zhipu-coding-plan/glm-5.3");
    expect(resolveOmpAcpBaseModelId("openai/gpt-5.4[reasoning=high]")).toBe("openai/gpt-5.4");
    expect(resolveOmpAcpBaseModelId("  anthropic/claude-opus-4-6  ")).toBe(
      "anthropic/claude-opus-4-6",
    );
    expect(resolveOmpAcpBaseModelId(undefined)).toBeUndefined();
    expect(resolveOmpAcpBaseModelId("")).toBeUndefined();
    expect(resolveOmpAcpBaseModelId("   ")).toBeUndefined();
  });
});

describe("applyOmpAcpModelSelection", () => {
  it("writes the requested model through the model config option before other options", async () => {
    const calls: Array<{
      readonly configId: string;
      readonly value: string | boolean;
    }> = [];

    const runtime = {
      getConfigOptions: Effect.succeed(ompConfigOptions),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ configId, value });
        }),
    };

    await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        model: "openai/gpt-5.4",
        selections: [{ id: "reasoning", value: "max" }],
        mapError: ({ configId, cause }) =>
          `failed to set config option ${configId}: ${cause.message}`,
      }),
    );

    expect(calls).toEqual([
      { configId: "model", value: "openai/gpt-5.4" },
      { configId: "thinking", value: "max" },
    ]);
  });

  it("validates reasoning against the post-switch options of the new model", async () => {
    // omp re-validates dependent selects per model: under `auto` the thinking
    // select only accepts off/auto, so a `max` request valid for the previous
    // model must be dropped rather than written and rejected by the CLI.
    const autoModelOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      ompConfigOptions[0]!,
      ompConfigOptions[1]!,
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "auto",
        options: [
          { value: "off", name: "Off" },
          { value: "auto", name: "Auto" },
        ],
      },
    ];
    const calls: Array<{
      readonly configId: string;
      readonly value: string | boolean;
    }> = [];

    const runtime = {
      getConfigOptions: Effect.sync(() =>
        calls.some((call) => call.configId === "model") ? autoModelOptions : ompConfigOptions,
      ),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ configId, value });
        }),
    };

    await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        model: "openai/gpt-5.4",
        selections: [{ id: "reasoning", value: "max" }],
        mapError: ({ configId, cause }) =>
          `failed to set config option ${configId}: ${cause.message}`,
      }),
    );

    expect(calls).toEqual([{ configId: "model", value: "openai/gpt-5.4" }]);
  });

  it("leaves the CLI's current model alone when no model is requested", async () => {
    const calls: Array<{
      readonly configId: string;
      readonly value: string | boolean;
    }> = [];

    const runtime = {
      getConfigOptions: Effect.succeed(ompConfigOptions),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ configId, value });
        }),
    };

    await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        model: undefined,
        selections: [{ id: "reasoning", value: "off" }],
        mapError: ({ configId, cause }) =>
          `failed to set config option ${configId}: ${cause.message}`,
      }),
    );

    expect(calls).toEqual([{ configId: "thinking", value: "off" }]);
  });
});
