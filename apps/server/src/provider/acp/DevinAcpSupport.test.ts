import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { DevinSettings, ProviderInstanceId } from "@t3tools/contracts";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  DEVIN_AUTH_METHOD_ID,
  resolveDevinAcpBaseModelId,
  resolveDevinAcpModelSelection,
} from "./DevinAcpSupport.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

describe("buildDevinAcpSpawnInput", () => {
  it("spawns 'devin acp' with default settings", () => {
    const settings = decodeDevinSettings({});
    const input = buildDevinAcpSpawnInput(settings, "/work");
    expect(input.command).toBe("devin");
    expect(input.args).toEqual(["acp"]);
    expect(input.cwd).toBe("/work");
    expect(input.env).toEqual({});
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

  it("omits default permissionMode", () => {
    const settings = decodeDevinSettings({
      permissionMode: "normal",
    });
    const input = buildDevinAcpSpawnInput(settings, "/work");
    expect(input.env).toEqual({});
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
    expect(input.env).toStrictEqual({ FOO: "bar" });
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
});

describe("Devin ACP auth method", () => {
  it("uses the devin-browser auth method advertised by the ACP agent", () => {
    expect(DEVIN_AUTH_METHOD_ID).toBe("devin-browser");
  });
});
