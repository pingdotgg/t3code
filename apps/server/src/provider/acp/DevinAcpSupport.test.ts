import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DevinSettings, ProviderInstanceId } from "@t3tools/contracts";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
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
      const setModel = vi.fn().mockReturnValue(Effect.succeed(undefined));
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
      const setModel = vi.fn().mockReturnValue(Effect.succeed(undefined));
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
      const setModel = vi.fn().mockReturnValue(Effect.succeed(undefined));
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
      const setModel = vi.fn().mockReturnValue(Effect.succeed(undefined));
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
});
