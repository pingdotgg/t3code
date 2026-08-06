import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  acpReasoningCapabilities,
  applyAcpReasoningConfig,
  buildAcpReasoningOptionDescriptor,
  findAcpReasoningConfigOption,
  resolveAcpReasoningConfigUpdate,
} from "./AcpReasoningConfig.ts";

const reasoningSelectOption = {
  id: "reasoning",
  name: "Reasoning Effort",
  category: "model_config",
  type: "select" as const,
  currentValue: "high",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

const effortByIdOption = {
  id: "effort",
  name: "Reasoning",
  category: "model_option",
  type: "select" as const,
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

/** Parameterized (grouped) select options, as the ACP schema allows. */
const parameterizedReasoningOption = {
  id: "thought_level",
  name: "Reasoning",
  category: "model_config",
  type: "select" as const,
  currentValue: "high",
  options: [
    {
      group: "levels",
      name: "Levels",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "high", name: "High (duplicate)" },
      ],
    },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

const unrelatedOption = {
  id: "approval",
  name: "Approval Mode",
  category: "permission",
  type: "select" as const,
  currentValue: "ask",
  options: [{ value: "ask", name: "Ask" }],
} satisfies EffectAcpSchema.SessionConfigOption;

describe("findAcpReasoningConfigOption", () => {
  it("matches a select option whose name mentions reasoning", () => {
    expect(findAcpReasoningConfigOption([unrelatedOption, reasoningSelectOption])).toBe(
      reasoningSelectOption,
    );
  });

  it("matches a select option whose id is effort", () => {
    expect(findAcpReasoningConfigOption([unrelatedOption, effortByIdOption])).toBe(
      effortByIdOption,
    );
  });

  it("ignores non-select and unrelated options", () => {
    expect(findAcpReasoningConfigOption([unrelatedOption])).toBeUndefined();
    expect(findAcpReasoningConfigOption([])).toBeUndefined();
    expect(findAcpReasoningConfigOption(undefined)).toBeUndefined();
  });
});

describe("buildAcpReasoningOptionDescriptor", () => {
  it("builds a reasoning descriptor from the CLI's native values and preselects its current value", () => {
    const descriptor = buildAcpReasoningOptionDescriptor([reasoningSelectOption]);
    expect(descriptor).toEqual({
      id: "reasoning",
      label: "Reasoning Effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    });
  });

  it("flattens parameterized select groups and de-duplicates by value", () => {
    const descriptor = buildAcpReasoningOptionDescriptor([parameterizedReasoningOption]);
    expect(descriptor?.options.map((option) => option.id)).toEqual(["low", "high"]);
    expect(descriptor?.options.find((option) => option.id === "high")?.isDefault).toBe(true);
    expect(descriptor?.currentValue).toBe("high");
  });

  it("falls back to the descriptor label and the value as the option label when the name is empty", () => {
    const option = {
      id: "effort",
      name: "",
      category: "model_option",
      type: "select" as const,
      currentValue: "v1",
      options: [{ value: "v1", name: "" }],
    } satisfies EffectAcpSchema.SessionConfigOption;
    const descriptor = buildAcpReasoningOptionDescriptor([option]);
    expect(descriptor?.label).toBe("Reasoning");
    expect(descriptor?.options).toEqual([{ id: "v1", label: "v1", isDefault: true }]);
  });

  it("returns undefined when no effort-shaped option is declared", () => {
    expect(buildAcpReasoningOptionDescriptor([unrelatedOption])).toBeUndefined();
    expect(buildAcpReasoningOptionDescriptor([])).toBeUndefined();
    expect(buildAcpReasoningOptionDescriptor(undefined)).toBeUndefined();
  });
});

describe("acpReasoningCapabilities", () => {
  it("carries the reasoning descriptor when one is declared", () => {
    const caps = acpReasoningCapabilities([reasoningSelectOption]);
    expect(caps.optionDescriptors?.length).toBe(1);
    expect(caps.optionDescriptors?.[0]?.id).toBe("reasoning");
  });

  it("is empty when no reasoning option is declared", () => {
    expect(acpReasoningCapabilities([unrelatedOption]).optionDescriptors).toEqual([]);
    expect(acpReasoningCapabilities(undefined).optionDescriptors).toEqual([]);
  });
});

describe("resolveAcpReasoningConfigUpdate", () => {
  it("maps a reasoning selection back to the originating config option", () => {
    expect(
      resolveAcpReasoningConfigUpdate([reasoningSelectOption], [{ id: "reasoning", value: "low" }]),
    ).toEqual({ configId: "reasoning", value: "low" });
  });

  it("matches the selection against the option name as a fallback", () => {
    expect(
      resolveAcpReasoningConfigUpdate([effortByIdOption], [{ id: "reasoning", value: "Medium" }]),
    ).toEqual({ configId: "effort", value: "medium" });
  });

  it("returns undefined when the selection is absent or unknown", () => {
    expect(resolveAcpReasoningConfigUpdate([reasoningSelectOption], undefined)).toBeUndefined();
    expect(
      resolveAcpReasoningConfigUpdate(
        [reasoningSelectOption],
        [{ id: "reasoning", value: "ultra" }],
      ),
    ).toBeUndefined();
  });

  it("returns undefined when no effort option is declared", () => {
    expect(
      resolveAcpReasoningConfigUpdate([unrelatedOption], [{ id: "reasoning", value: "low" }]),
    ).toBeUndefined();
  });
});

function makeStubRuntime(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  setConfigOptionImpl: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, unknown>,
) {
  const calls: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  return {
    runtime: {
      getConfigOptions: Effect.succeed(configOptions),
      setConfigOption: (configId: string, value: string | boolean) => {
        calls.push({ configId, value });
        return setConfigOptionImpl(configId, value);
      },
    },
    calls,
  };
}

describe("applyAcpReasoningConfig", () => {
  it("applies the reasoning selection through session/set_config_option and returns the value", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeStubRuntime([reasoningSelectOption], () => Effect.void);
      const applied = yield* applyAcpReasoningConfig({
        runtime,
        selections: [{ id: "reasoning", value: "low" }],
        mapError: () => "applied-error" as const,
      });
      expect(applied).toBe("low");
      expect(calls).toEqual([{ configId: "reasoning", value: "low" }]);
    }).pipe(Effect.runPromise));

  it("is a no-op (and returns undefined) when no reasoning selection is present", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeStubRuntime([reasoningSelectOption], () => Effect.void);
      const applied = yield* applyAcpReasoningConfig({
        runtime,
        selections: undefined,
        mapError: () => "applied-error" as const,
      });
      expect(applied).toBeUndefined();
      expect(calls).toEqual([]);
    }).pipe(Effect.runPromise));

  it("is a no-op when the ACP server declares no effort option", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeStubRuntime([unrelatedOption], () => Effect.void);
      const applied = yield* applyAcpReasoningConfig({
        runtime,
        selections: [{ id: "reasoning", value: "low" }],
        mapError: () => "applied-error" as const,
      });
      expect(applied).toBeUndefined();
      expect(calls).toEqual([]);
    }).pipe(Effect.runPromise));

  it("maps the set_config_option error through mapError", () =>
    Effect.gen(function* () {
      const { runtime } = makeStubRuntime([reasoningSelectOption], () =>
        Effect.fail(new Error("rpc failed")),
      );
      const exit = yield* applyAcpReasoningConfig({
        runtime,
        selections: [{ id: "reasoning", value: "low" }],
        mapError: (cause) => ({ _tag: "SetConfigOptionFailed" as const, cause }),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as { _tag?: string };
        expect(error._tag).toBe("SetConfigOptionFailed");
      }
    }).pipe(Effect.runPromise));
});
