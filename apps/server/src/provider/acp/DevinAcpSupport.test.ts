import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  currentDevinModelIdFromSessionSetup,
  devinAcpModelVariantGroupsFromConfigOptions,
  isDevinAcpModelCoveredByBaseModelIds,
  resolveDevinAcpDisplayModelId,
  resolveDevinAcpModelSelection,
} from "./DevinAcpSupport.ts";

describe("DevinAcpSupport", () => {
  it("passes the config path as a Devin global flag before the acp subcommand", () => {
    expect(
      buildDevinAcpSpawnInput(
        {
          binaryPath: "devin",
          configPath: " C:\\devin\\test-config.json ",
        },
        "C:\\workspace\\t3code",
      ),
    ).toEqual({
      command: "devin",
      args: ["--config", "C:\\devin\\test-config.json", "acp"],
      cwd: "C:\\workspace\\t3code",
    });
  });

  it("reads the current model from ACP configOptions before unstable model state", () => {
    const response = {
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "adaptive",
          options: [{ value: "adaptive", name: "Adaptive" }],
        },
      ],
      models: {
        currentModelId: "legacy-model-state",
        availableModels: [{ modelId: "legacy-model-state", name: "Legacy" }],
      },
    } satisfies EffectAcpSchema.NewSessionResponse;

    expect(currentDevinModelIdFromSessionSetup(response)).toBe("adaptive");
  });

  it("groups Devin thinking and speed variants by base model", () => {
    const groups = devinAcpModelVariantGroupsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5-5-high-priority",
        options: [
          { value: "gpt-5-5-low", name: "GPT-5.5 Low Thinking" },
          { value: "gpt-5-5-high-priority", name: "GPT-5.5 High Thinking Fast" },
          { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
          { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
        ],
      },
    ]);

    expect(
      groups.map((group) => ({
        id: group.baseModelId,
        name: group.baseModelName,
        current: group.currentVariant?.exactModelId,
        variants: group.variants.map((variant) => ({
          exact: variant.exactModelId,
          reasoning: variant.reasoning,
          fast: variant.fastMode,
        })),
      })),
    ).toEqual([
      {
        id: "gpt-5-5",
        name: "GPT-5.5",
        current: "gpt-5-5-high-priority",
        variants: [
          { exact: "gpt-5-5-low", reasoning: "low", fast: false },
          { exact: "gpt-5-5-high-priority", reasoning: "high", fast: true },
        ],
      },
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        current: undefined,
        variants: [
          { exact: "MODEL_PRIVATE_2", reasoning: undefined, fast: false },
          { exact: "MODEL_PRIVATE_3", reasoning: "thinking", fast: false },
        ],
      },
    ]);
  });

  it("resolves Devin base model options back to exact ACP model ids", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "adaptive",
        options: [
          { value: "gpt-5-5-low", name: "GPT-5.5 Low Thinking" },
          { value: "gpt-5-5-high", name: "GPT-5.5 High Thinking" },
          { value: "gpt-5-5-high-priority", name: "GPT-5.5 High Thinking Fast" },
          { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
          { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
        ],
      },
    ];

    expect(
      resolveDevinAcpModelSelection({
        configOptions,
        model: "gpt-5-5",
        selections: [
          { id: "reasoning", value: "high" },
          { id: "fastMode", value: true },
        ],
      }),
    ).toBe("gpt-5-5-high-priority");
    expect(
      resolveDevinAcpModelSelection({
        configOptions,
        model: "claude-sonnet-4-5",
        selections: [{ id: "reasoning", value: "thinking" }],
      }),
    ).toBe("MODEL_PRIVATE_3");
  });

  it("resolves base model selections to the ACP current variant when no options are supplied", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5-5-high-priority",
        options: [
          { value: "gpt-5-5-low", name: "GPT-5.5 Low Thinking" },
          { value: "gpt-5-5-high-priority", name: "GPT-5.5 High Thinking Fast" },
        ],
      },
    ];

    expect(
      resolveDevinAcpModelSelection({
        configOptions,
        model: "gpt-5-5",
        selections: [],
      }),
    ).toBe("gpt-5-5-high-priority");
  });

  it("maps exact private ACP model ids to grouped display ids", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "MODEL_PRIVATE_2",
        options: [
          { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
          { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
        ],
      },
    ];

    expect(resolveDevinAcpDisplayModelId(configOptions, "MODEL_PRIVATE_2")).toBe(
      "claude-sonnet-4-5",
    );
  });

  it("treats built-in Devin aliases as covering previous discovered concrete slugs", () => {
    expect(
      isDevinAcpModelCoveredByBaseModelIds({
        modelId: "claude-sonnet-4-5",
        modelName: "Claude Sonnet 4.5",
        baseModelIds: new Set(["sonnet"]),
      }),
    ).toBe(true);
  });

  it.effect("switches Devin models through ACP set_config_option", () =>
    Effect.gen(function* () {
      const modelCalls: Array<string> = [];
      const runtime = {
        setModel: (modelId: string) =>
          Effect.sync(() => {
            modelCalls.push(modelId);
          }),
      };

      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "swe-1-6",
        mapError: (cause) => cause.message,
      });

      expect(modelCalls).toEqual(["swe-1-6"]);
      expect(result).toBe("swe-1-6");
    }),
  );

  it.effect("maps Devin model switch failures", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unsupported model");
      const runtime = {
        setModel: (_modelId: string) => Effect.fail(failure),
      };

      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          currentModelId: "adaptive",
          requestedModelId: "swe-1-6",
          mapError: (cause) => cause.message,
        }),
      );

      expect(error).toBe(failure.message);
    }),
  );
});
