import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import { DevinSettings, ProviderInstanceId } from "@t3tools/contracts";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  buildDevinGlobalArgs,
  DEVIN_AUTH_METHOD_ID,
  isDevinAuthenticationFailure,
  resolveDevinAcpBaseModelId,
  resolveDevinAcpModelSelection,
} from "./DevinAcpSupport.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

describe("buildDevinAcpSpawnInput", () => {
  it("spawns 'devin acp' with default settings", () => {
    const settings = decodeDevinSettings({});
    const input = buildDevinAcpSpawnInput(settings, "/work", {
      DEVIN_PERMISSION_MODE: "dangerous",
    });
    expect(input.command).toBe("devin");
    expect(input.args).toEqual(["acp"]);
    expect(input.cwd).toBe("/work");
    expect(input.env).toEqual({ DEVIN_PERMISSION_MODE: "normal" });
  });

  it("maps permissionMode to env var", () => {
    const settings = decodeDevinSettings({
      permissionMode: "smart",
    });
    const input = buildDevinAcpSpawnInput(settings, "/work");
    expect(input.command).toBe("devin");
    expect(input.args).toEqual(["acp"]);
    expect(input.env).toMatchObject({
      DEVIN_PERMISSION_MODE: "smart",
    });
  });

  it("maps every ACP runtime control to the documented Devin CLI arguments", () => {
    const settings = decodeDevinSettings({
      binaryPath: "/opt/devin/bin/devin",
      configPath: "/profiles/devin config.json",
      agentType: "review",
      sandbox: true,
      respectWorkspaceTrust: false,
      launchArgs: '--model "GPT-5.6 Sol"',
    });
    const input = buildDevinAcpSpawnInput(settings, "/work");

    expect(input.command).toBe("/opt/devin/bin/devin");
    expect(input.args).toEqual([
      "--config",
      "/profiles/devin config.json",
      "--sandbox",
      "--respect-workspace-trust",
      "false",
      "acp",
      "--agent-type",
      "review",
      "--model",
      "GPT-5.6 Sol",
    ]);
  });

  it("supports Devin's no-tools summarizer agent without changing global defaults", () => {
    const settings = decodeDevinSettings({ agentType: "summarizer" });
    const input = buildDevinAcpSpawnInput(settings, "/work");

    expect(input.args).toEqual(["acp", "--agent-type", "summarizer"]);
  });

  it("expands a shell-style home path before passing the config file to spawn", () => {
    const args = buildDevinGlobalArgs(decodeDevinSettings({ configPath: "~/.devin/team.json" }));

    expect(args).toEqual(["--config", expect.stringMatching(/\/\.devin\/team\.json$/)]);
    expect(args[1]).not.toContain("~");
  });

  it("overrides an inherited permission mode with the configured default", () => {
    const settings = decodeDevinSettings({
      permissionMode: "normal",
    });
    const input = buildDevinAcpSpawnInput(settings, "/work", {
      DEVIN_PERMISSION_MODE: "dangerous",
    });
    expect(input.env).toEqual({ DEVIN_PERMISSION_MODE: "normal" });
  });

  it("uses the configured binaryPath", () => {
    const settings = decodeDevinSettings({
      binaryPath: "/usr/local/bin/devin",
    });
    const input = buildDevinAcpSpawnInput(settings, "/work");
    expect(input.command).toBe("/usr/local/bin/devin");
  });

  it("merges environment variables", () => {
    const env = { FOO: "bar" };
    const input = buildDevinAcpSpawnInput(decodeDevinSettings({}), "/work", env);
    expect(input.env).toStrictEqual({ FOO: "bar", DEVIN_PERMISSION_MODE: "normal" });
    expect(input.env).not.toBe(env);
  });
});

describe("resolveDevinAcpBaseModelId", () => {
  it("trims and normalizes model slugs", () => {
    expect(resolveDevinAcpBaseModelId("  opus  ")).toBe("opus");
  });

  it("falls back to 'adaptive' when blank", () => {
    expect(resolveDevinAcpBaseModelId("")).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId(undefined)).toBe("adaptive");
  });
});

describe("resolveDevinAcpModelSelection", () => {
  it("returns the family slug and reasoning option", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("devin"),
      model: "claude-opus-5",
      options: [{ id: "reasoning", value: "high" }],
    };
    expect(resolveDevinAcpModelSelection(modelSelection)).toEqual({
      familySlug: "claude-opus-5",
      reasoningValue: "high",
    });
  });

  it("falls back to the family slug when no reasoning option is set", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("devin"),
      model: "claude-opus-5",
    };
    expect(resolveDevinAcpModelSelection(modelSelection)).toEqual({
      familySlug: "claude-opus-5",
      reasoningValue: undefined,
    });
  });
});

describe("applyDevinAcpModelSelection", () => {
  it.effect("sets the model through the model config option", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: { familySlug: "claude-opus-5", reasoningValue: undefined },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "claude-opus-5", name: "Claude Opus 5" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("claude-opus-5");
      expect(setConfigOption).not.toHaveBeenCalled();
      expect(result).toEqual({
        familySlug: "claude-opus-5",
        reasoningValue: undefined,
      });
    }),
  );

  it.effect("maps an opaque ACP model id through its display name", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: { familySlug: "adaptive", reasoningValue: undefined },
        requested: { familySlug: "claude-haiku-4-5", reasoningValue: undefined },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "MODEL_PRIVATE_11", name: "Claude Haiku 4.5" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("MODEL_PRIVATE_11");
      expect(setConfigOption).not.toHaveBeenCalled();
      expect(result).toEqual({
        familySlug: "claude-haiku-4-5",
        reasoningValue: undefined,
      });
    }),
  );

  it.effect("maps an opaque ACP reasoning variant through its display name", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: { familySlug: "adaptive", reasoningValue: undefined },
        requested: { familySlug: "gpt-5-2", reasoningValue: "low-thinking" },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "MODEL_GPT_5_2_LOW", name: "GPT-5.2 Low Thinking" },
              { value: "MODEL_GPT_5_2_HIGH", name: "GPT-5.2 High Thinking" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("MODEL_GPT_5_2_LOW");
      expect(setConfigOption).not.toHaveBeenCalled();
      expect(result).toEqual({
        familySlug: "gpt-5-2",
        reasoningValue: "low-thinking",
      });
    }),
  );

  it.effect("sets reasoning through the effort config option when present", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: { familySlug: "claude-opus-5", reasoningValue: "high" },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "claude-opus-5", name: "Claude Opus 5" },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "high", name: "High" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("claude-opus-5");
      expect(setConfigOption).toHaveBeenCalledWith("effort", "high");
      expect(result).toEqual({
        familySlug: "claude-opus-5",
        reasoningValue: "high",
      });
    }),
  );

  it.effect("recognizes the underscored thought level id without a reasoning category", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: { familySlug: "claude-opus-5", reasoningValue: "high" },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "claude-opus-5", name: "Claude Opus 5" },
            ],
          },
          {
            id: "thought_level",
            name: "Thought level",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "high", name: "High" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setConfigOption).toHaveBeenCalledWith("thought_level", "high");
    }),
  );

  it.effect("keeps Devin adaptive when a stale model from another provider is requested", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: { familySlug: "adaptive", reasoningValue: "default" },
        requested: { familySlug: "gpt-5-6-sol", reasoningValue: "max-thinking" },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "claude-opus-5", name: "Claude Opus 5" },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "high", name: "High" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).not.toHaveBeenCalled();
      expect(setConfigOption).not.toHaveBeenCalled();
      expect(result).toEqual({
        familySlug: "adaptive",
        reasoningValue: "default",
      });
    }),
  );

  it.effect("keeps the current reasoning when a stale reasoning value is requested", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: { familySlug: "claude-opus-5", reasoningValue: "default" },
        requested: { familySlug: "claude-opus-5", reasoningValue: "max-thinking" },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "claude-opus-5",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "claude-opus-5", name: "Claude Opus 5" },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "high", name: "High" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).not.toHaveBeenCalled();
      expect(setConfigOption).not.toHaveBeenCalled();
      expect(result).toEqual({
        familySlug: "claude-opus-5",
        reasoningValue: "default",
      });
    }),
  );

  it.effect("falls back to a variant slug when the family slug is not in the model list", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: { familySlug: "claude-opus-5", reasoningValue: "high" },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "claude-opus-5-high", name: "Claude Opus 5 High" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("claude-opus-5-high");
    }),
  );

  it.effect("switches embedded reasoning variants within the same model family", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: {
          familySlug: "gpt-5-6-sol",
          reasoningValue: "medium-thinking",
        },
        requested: {
          familySlug: "gpt-5-6-sol",
          reasoningValue: "max-thinking",
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gpt-5-6-sol-medium",
            options: [
              { value: "gpt-5-6-sol-medium", name: "GPT-5.6 Sol Medium" },
              { value: "gpt-5-6-sol-max", name: "GPT-5.6 Sol Max" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("gpt-5-6-sol-max");
      expect(setConfigOption).not.toHaveBeenCalled();
      expect(result).toEqual({
        familySlug: "gpt-5-6-sol",
        reasoningValue: "max-thinking",
      });
    }),
  );

  it.effect("normalizes a legacy reasoning option value that contains the family slug", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: {
          familySlug: "swe-1-7",
          reasoningValue: "swe-1-7-medium",
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "swe-1-7", name: "SWE-1.7" },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "default",
            options: [
              { value: "max", name: "Max" },
              { value: "medium", name: "Medium" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("swe-1-7");
      expect(setConfigOption).toHaveBeenCalledWith("effort", "medium");
    }),
  );

  it.effect("fails when no model config option is discovered and a model switch is needed", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: { familySlug: "claude-opus-5", reasoningValue: "high" },
        configOptions: [
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "high", name: "High" },
            ],
          },
        ],
        mapError: (cause) => cause,
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("AcpRequestError");
        expect(result.failure.message).toContain("no model session config option was found");
      }
      expect(setModel).not.toHaveBeenCalled();
      expect(setConfigOption).not.toHaveBeenCalled();
    }),
  );

  it.effect("resets reasoning to default when the user requests the default reasoning value", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: { familySlug: "claude-opus-5", reasoningValue: "high" },
        requested: {
          familySlug: "claude-opus-5",
          reasoningValue: "default",
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "claude-opus-5",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "claude-opus-5", name: "Claude Opus 5" },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "default", name: "Default" },
              { value: "high", name: "High" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).not.toHaveBeenCalled();
      expect(setConfigOption).toHaveBeenCalledWith("effort", "default");
      expect(result).toEqual({
        familySlug: "claude-opus-5",
        reasoningValue: undefined,
      });
    }),
  );

  it.effect("maps a reasoning synonym to an allowed reasoning config value", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      const result = yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: {
          familySlug: "claude-opus-5",
          reasoningValue: "no-thinking",
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "claude-opus-5", name: "Claude Opus 5" },
            ],
          },
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "low",
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("claude-opus-5");
      expect(setConfigOption).toHaveBeenCalledWith("reasoning", "none");
      expect(result).toEqual({
        familySlug: "claude-opus-5",
        reasoningValue: "none",
      });
    }),
  );

  it.effect(
    "uses the base model when default reasoning is requested and no reasoning config is present",
    () =>
      Effect.gen(function* () {
        const setModel = vi.fn().mockReturnValue(Effect.void);
        const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

        const result = yield* applyDevinAcpModelSelection({
          runtime: { setModel, setConfigOption },
          current: undefined,
          requested: {
            familySlug: "claude-opus-5",
            reasoningValue: "default",
          },
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "adaptive",
              options: [
                { value: "adaptive", name: "Adaptive" },
                { value: "claude-opus-5", name: "Claude Opus 5" },
              ],
            },
          ],
          mapError: (cause) => cause,
        });

        expect(setModel).toHaveBeenCalledWith("claude-opus-5");
        expect(setConfigOption).not.toHaveBeenCalled();
        expect(result).toEqual({
          familySlug: "claude-opus-5",
          reasoningValue: undefined,
        });
      }),
  );
});

describe("Devin reasoning variant synonyms", () => {
  it.effect("maps no-thinking to the none variant", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: { familySlug: "glm-5-2", reasoningValue: "no-thinking" },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "glm-5-2", name: "GLM-5.2" },
              { value: "glm-5-2-none", name: "GLM-5.2 No Thinking" },
              { value: "glm-5-2-1m", name: "GLM-5.2 No Thinking 1M" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("glm-5-2-none");
      expect(setConfigOption).not.toHaveBeenCalled();
    }),
  );

  it.effect("maps no-thinking-1m to the 1m variant", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: { familySlug: "glm-5-2", reasoningValue: "no-thinking-1m" },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "glm-5-2", name: "GLM-5.2" },
              { value: "glm-5-2-none", name: "GLM-5.2 No Thinking" },
              { value: "glm-5-2-1m", name: "GLM-5.2 No Thinking 1M" },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("glm-5-2-1m");
      expect(setConfigOption).not.toHaveBeenCalled();
    }),
  );

  it.effect("maps lightning-medium to the lightning-medium variant", () =>
    Effect.gen(function* () {
      const setModel = vi.fn().mockReturnValue(Effect.void);
      const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

      yield* applyDevinAcpModelSelection({
        runtime: { setModel, setConfigOption },
        current: undefined,
        requested: {
          familySlug: "swe-1-7",
          reasoningValue: "lightning-medium",
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "adaptive",
            options: [
              { value: "adaptive", name: "Adaptive" },
              { value: "swe-1-7", name: "SWE-1.7" },
              { value: "swe-1-7-medium", name: "SWE-1.7 Medium" },
              { value: "swe-1-7-lightning", name: "SWE-1.7 Lightning" },
              {
                value: "swe-1-7-lightning-medium",
                name: "SWE-1.7 Lightning Medium",
              },
            ],
          },
        ],
        mapError: (cause) => cause,
      });

      expect(setModel).toHaveBeenCalledWith("swe-1-7-lightning-medium");
      expect(setConfigOption).not.toHaveBeenCalled();
    }),
  );

  it.effect("maps model-list thinking labels to ACP model suffixes", () =>
    Effect.gen(function* () {
      const cases = [
        ["medium-thinking", "gpt-5-6-sol-medium"],
        ["max-thinking", "gpt-5-6-sol-max"],
        ["no-thinking-fast", "gpt-5-6-sol-none-priority"],
        ["xhigh-thinking-fast", "gpt-5-6-sol-xhigh-priority"],
      ] as const;

      for (const [reasoningValue, expectedModel] of cases) {
        const setModel = vi.fn().mockReturnValue(Effect.void);
        const setConfigOption = vi.fn().mockReturnValue(Effect.succeed({ configOptions: [] }));

        const result = yield* applyDevinAcpModelSelection({
          runtime: { setModel, setConfigOption },
          current: undefined,
          requested: { familySlug: "gpt-5-6-sol", reasoningValue },
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "adaptive",
              options: [
                { value: "adaptive", name: "Adaptive" },
                { value: "gpt-5-6-sol-medium", name: "GPT-5.6 Sol Medium" },
                { value: "gpt-5-6-sol-max", name: "GPT-5.6 Sol Max" },
                {
                  value: "gpt-5-6-sol-none-priority",
                  name: "GPT-5.6 Sol No Thinking Fast",
                },
                {
                  value: "gpt-5-6-sol-xhigh-priority",
                  name: "GPT-5.6 Sol XHigh Thinking Fast",
                },
              ],
            },
          ],
          mapError: (cause) => cause,
        });

        expect(setModel).toHaveBeenCalledWith(expectedModel);
        expect(setConfigOption).not.toHaveBeenCalled();
        expect(result).toEqual({
          familySlug: "gpt-5-6-sol",
          reasoningValue,
        });
      }
    }),
  );
});

describe("Devin ACP auth method", () => {
  it("uses the devin-browser auth method advertised by the ACP agent", () => {
    expect(DEVIN_AUTH_METHOD_ID).toBe("devin-browser");
  });

  it("recognizes only Devin's explicit logged-out prompt failure", () => {
    expect(
      isDevinAuthenticationFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage:
            "Authentication failed: Please authenticate to continue. Run `/login` to log in.",
        }),
      ),
    ).toBe(true);
    expect(
      isDevinAuthenticationFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Authentication service returned an unrelated internal error.",
        }),
      ),
    ).toBe(false);
    expect(
      isDevinAuthenticationFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Mock prompt failure",
        }),
      ),
    ).toBe(false);
  });
});
