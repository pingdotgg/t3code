import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "@effect/vitest";

import { applyDevinAcpModelSelection, buildDevinAcpSpawnInput } from "./DevinAcpSupport.ts";

const devinConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "adaptive",
    options: [
      { value: "adaptive", name: "Adaptive" },
      { value: "swe-2-max", name: "SWE-2 Max" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "accept-edits",
    options: [
      { value: "accept-edits", name: "Accept edits" },
      { value: "bypass", name: "Bypass permissions" },
    ],
  },
  {
    id: "thought_level",
    name: "Thought level",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("honours a configured binary path and environment", () => {
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "/opt/devin/bin/devin" }, "/tmp/project", {
        XDG_DATA_HOME: "/tmp/devin-home",
      }),
    ).toEqual({
      command: "/opt/devin/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { XDG_DATA_HOME: "/tmp/devin-home" },
    });
  });
});

describe("applyDevinAcpModelSelection", () => {
  const makeRecordingRuntime = () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];
    const runtime = {
      getConfigOptions: Effect.succeed(devinConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };
    return { runtime, calls };
  };

  it.effect("routes the model through setModel (the session's model config option)", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-2-max",
        selections: undefined,
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([{ type: "model", value: "swe-2-max" }]);
    }),
  );

  it.effect("applies the reasoning selection through the thought_level config option", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-2-max",
        selections: [{ id: "reasoning", value: "max" }],
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([
        { type: "model", value: "swe-2-max" },
        { type: "config", configId: "thought_level", value: "max" },
      ]);
    }),
  );

  it.effect("falls back to adaptive when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      yield* applyDevinAcpModelSelection({
        runtime,
        model: undefined,
        selections: undefined,
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([{ type: "model", value: "adaptive" }]);
    }),
  );

  it.effect("ignores selections that do not resolve to a Devin thought level", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-2-max",
        selections: [{ id: "reasoning", value: "ultra" }],
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([{ type: "model", value: "swe-2-max" }]);
    }),
  );
});
