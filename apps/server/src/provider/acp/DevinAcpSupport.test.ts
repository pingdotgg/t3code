import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import { applyDevinAcpModelSelection, buildDevinAcpSpawnInput } from "./DevinAcpSupport.ts";

const devinConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: "accept-edits",
    options: [
      { value: "accept-edits", name: "Code" },
      { value: "ask", name: "Ask" },
      { value: "plan", name: "Plan" },
      { value: "bypass", name: "Bypass Permissions" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "glm-5-2",
    options: [
      { value: "adaptive", name: "Adaptive" },
      { value: "glm-5-2", name: "GLM-5.2" },
    ],
  },
];

const makeRecordingRuntime = () => {
  const calls: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  const runtime = {
    getConfigOptions: Effect.succeed(devinConfigOptions),
    setConfigOption: (configId: string, value: string | boolean) =>
      Effect.sync(() => {
        calls.push({ configId, value });
      }),
  };
  return { runtime, calls };
};

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary path and forwards the environment", () => {
    const env = { ...process.env, DEVIN_MODEL: "opus" };
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "/usr/local/bin/devin" }, "/tmp/project", env),
    ).toEqual({
      command: "/usr/local/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env,
    });
  });
});

describe("applyDevinAcpModelSelection", () => {
  it.effect("sets the model config option when it differs", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "adaptive",
        selections: [],
        mapError: ({ step, configId }) => `${step}:${configId}`,
      });
      expect(calls).toEqual([{ configId: "model", value: "adaptive" }]);
    }),
  );

  it.effect("skips the model reselect when it already matches", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "glm-5-2",
        selections: [],
        mapError: ({ step, configId }) => `${step}:${configId}`,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("ignores empty model requests", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "  ",
        selections: [],
        mapError: ({ step, configId }) => `${step}:${configId}`,
      });
      expect(calls).toEqual([]);
    }),
  );
});
