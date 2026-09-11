import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import type { ProviderOptionSelection } from "@t3tools/contracts";
import { AcpRequestError } from "effect-acp/errors";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  resolveDevinAcpBaseModelId,
  resolveDevinModelUid,
} from "./DevinAcpSupport.ts";

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses a configured binary and environment", () => {
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "/usr/local/bin/devin" }, "/tmp/project", {
        DEVIN_ORG: "example",
      }),
    ).toEqual({
      command: "/usr/local/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { DEVIN_ORG: "example" },
    });
  });
});

describe("applyDevinAcpModelSelection", () => {
  const variants = ["swe-2-high", "swe-2-medium", "swe-2-max"];
  const swe2Config = (currentValue: string) => [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue,
      options: [
        {
          group: "SWE-2",
          name: "SWE-2",
          options: variants.map((value) => ({ value, name: value })),
        },
      ],
    },
  ];
  const swe2Cases: ReadonlyArray<{
    name: string;
    model: string;
    current: string;
    expected: string;
    selections?: ReadonlyArray<ProviderOptionSelection>;
  }> = [
    {
      name: "uses the current advertised variant for a family",
      model: "swe-2",
      current: "swe-2-medium",
      expected: "swe-2-medium",
    },
    {
      name: "uses the first family variant when the current model differs",
      model: "swe-2",
      current: "unrelated-model",
      expected: "swe-2-high",
    },
    {
      name: "preserves an explicit concrete variant",
      model: "swe-2-max",
      current: "swe-2-high",
      expected: "swe-2-max",
    },
    {
      name: "honors the selected reasoning level",
      model: "swe-2",
      current: "swe-2-high",
      selections: [{ id: "reasoning", value: "max" }],
      expected: "swe-2-max",
    },
  ];
  for (const example of swe2Cases) {
    it.effect(`SWE-2 ${example.name}`, () => {
      const calls: string[] = [];
      return applyDevinAcpModelSelection({
        model: example.model,
        selections: example.selections,
        runtime: {
          getConfigOptions: Effect.succeed(swe2Config(example.current)),
          setModel: (model) =>
            Effect.sync(() => {
              expect(variants).toContain(model);
              calls.push(model);
            }),
        },
        mapError: ({ cause }) => cause,
      }).pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual([example.expected]))));
    });
  }

  it.effect("SWE-2 rejects an unavailable explicit option instead of silently changing it", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      model: "swe-2",
      selections: [{ id: "reasoning", value: "low" }],
      runtime: {
        getConfigOptions: Effect.succeed(swe2Config("swe-2-high")),
        setModel: (model) =>
          Effect.suspend(() => {
            calls.push(model);
            return variants.includes(model)
              ? Effect.void
              : Effect.fail(AcpRequestError.invalidParams("Unavailable SWE-2 variant"));
          }),
      },
      mapError: ({ cause }) => cause,
    }).pipe(
      Effect.flip,
      Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["swe-2-low"]))),
    );
  });

  it.effect("selects the requested model through ACP config", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        getConfigOptions: Effect.succeed([]),
        setModel: (model) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
      },
      model: "claude-sonnet-4-6",
      mapError: ({ cause }) => cause,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["claude-sonnet-4-6"]))));
  });

  it.effect("folds a reasoning option into the full model UID", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        getConfigOptions: Effect.succeed([]),
        setModel: (model) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
      },
      model: "claude-opus-5",
      selections: [{ id: "reasoning", value: "high" }],
      mapError: ({ cause }) => cause,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["claude-opus-5-high"]))));
  });

  it.effect("falls back to an unsuffixed no-thinking UID when a CLI uses that form", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        getConfigOptions: Effect.succeed([]),
        setModel: (model) =>
          Effect.gen(function* () {
            calls.push(model);
            if (model.endsWith("-none")) {
              return yield* Effect.fail(new Error("unknown model") as never);
            }
          }),
      },
      model: "claude-opus-4-6",
      selections: [{ id: "reasoning", value: "none" }],
      mapError: ({ cause }) => cause,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => expect(calls).toEqual(["claude-opus-4-6-none", "claude-opus-4-6"])),
      ),
    );
  });

  it("falls back to adaptive", () => {
    expect(resolveDevinAcpBaseModelId("  ")).toBe("adaptive");
  });
});

describe("resolveDevinModelUid", () => {
  it("combines a base slug with a reasoning option using a hyphen", () => {
    expect(resolveDevinModelUid("claude-opus-5", [{ id: "reasoning", value: "medium" }])).toBe(
      "claude-opus-5-medium",
    );
  });

  it("inserts the reasoning level before a speed tier", () => {
    expect(resolveDevinModelUid("claude-opus-5-fast", [{ id: "reasoning", value: "medium" }])).toBe(
      "claude-opus-5-medium-fast",
    );
  });

  it("combines reasoning, speed, and context options", () => {
    expect(
      resolveDevinModelUid("glm-5-2", [
        { id: "reasoning", value: "max" },
        { id: "speed", value: "priority" },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toBe("glm-5-2-max-priority-1m");
  });

  it("uses GLM's unsuffixed UID for High", () => {
    expect(resolveDevinModelUid("glm-5-2", [{ id: "reasoning", value: "high" }])).toBe("glm-5-2");
    expect(
      resolveDevinModelUid("glm-5-2", [
        { id: "reasoning", value: "high" },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toBe("glm-5-2-1m");
  });

  it("does not encode GLM's implicit 200K context in the UID", () => {
    expect(
      resolveDevinModelUid("glm-5-2", [
        { id: "reasoning", value: "max" },
        { id: "contextWindow", value: "200k" },
      ]),
    ).toBe("glm-5-2-max");
    expect(
      resolveDevinModelUid("glm-5-2", [
        { id: "reasoning", value: "none" },
        { id: "contextWindow", value: "200k" },
      ]),
    ).toBe("glm-5-2-none");
  });

  it("combines uppercase enum-style bases with an underscore and uppercased suffix", () => {
    expect(resolveDevinModelUid("MODEL_GPT_5_2", [{ id: "reasoning", value: "low" }])).toBe(
      "MODEL_GPT_5_2_LOW",
    );
  });

  it("accepts an explicit UID for opaque Devin reasoning variants", () => {
    expect(
      resolveDevinModelUid("MODEL_PRIVATE_2", [
        { id: "reasoning", value: "__uid:MODEL_PRIVATE_3" },
      ]),
    ).toBe("MODEL_PRIVATE_3");
  });

  it("returns the base slug when no reasoning option is provided", () => {
    expect(resolveDevinModelUid("claude-opus-5")).toBe("claude-opus-5");
    expect(resolveDevinModelUid("claude-opus-5-fast", [])).toBe("claude-opus-5-fast");
  });

  it("ignores a non-string reasoning value", () => {
    expect(resolveDevinModelUid("claude-opus-5", [{ id: "reasoning", value: true }])).toBe(
      "claude-opus-5",
    );
  });

  it("falls back to adaptive for empty input", () => {
    expect(resolveDevinModelUid("   ")).toBe("adaptive");
  });
});
