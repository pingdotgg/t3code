import { describe, expect, it } from "vite-plus/test";

import {
  devinModelsFromCatalog,
  normalizeDevinModelId,
  parseDevinModelUid,
  resolveDevinModelUid,
} from "./devinModelCatalog.ts";

describe("parseDevinModelUid", () => {
  it("parses effort, speed, and context suffixes", () => {
    expect(parseDevinModelUid("claude-opus-5-low-fast")).toEqual({
      base: "claude-opus-5",
      effort: "low",
      speed: "fast",
      context: undefined,
    });
    expect(parseDevinModelUid("glm-5-2-max-1m")).toEqual({
      base: "glm-5-2",
      effort: "max",
      speed: undefined,
      context: "1m",
    });
    expect(parseDevinModelUid("gpt-5-6-sol-none-priority")).toEqual({
      base: "gpt-5-6-sol",
      effort: "none",
      speed: "priority",
      context: undefined,
    });
  });

  it("parses underscore-separated uids", () => {
    expect(parseDevinModelUid("MODEL_GPT_5_2_LOW")).toEqual({
      base: "model-gpt-5-2",
      effort: "low",
      speed: undefined,
      context: undefined,
    });
    expect(parseDevinModelUid("MODEL_CLAUDE_4_5_OPUS_THINKING")).toEqual({
      base: "model-claude-4-5-opus",
      effort: "thinking",
      speed: undefined,
      context: undefined,
    });
  });

  it("leaves bare uids untouched", () => {
    for (const uid of ["adaptive", "kimi-k2-6", "swe-1-7-lightning", "MODEL_PRIVATE_11"]) {
      const dims = parseDevinModelUid(uid);
      expect(dims.effort).toBeUndefined();
      expect(dims.speed).toBeUndefined();
      expect(dims.context).toBeUndefined();
      expect(dims.base).toBe(normalizeDevinModelId(uid));
    }
  });
});

describe("devinModelsFromCatalog grouping", () => {
  it("emits a Speed select for fast variants", () => {
    const models = devinModelsFromCatalog({
      families: [
        {
          family_label: "Claude Opus 5",
          family_uid: "claude-opus-5",
          variants: [
            { model_uid: "claude-opus-5-low" },
            { model_uid: "claude-opus-5-high" },
            { model_uid: "claude-opus-5-low-fast" },
            { model_uid: "claude-opus-5-high-fast" },
          ],
        },
      ],
    });
    const opus = models[0]!;
    expect(opus.slug).toBe("claude-opus-5");
    expect(opus.name).toBe("Claude Opus 5");
    const descriptors = opus.capabilities?.optionDescriptors ?? [];
    const speed = descriptors.find((d) => d.id === "speed");
    expect(speed?.type === "select" ? speed.options.map((o) => o.id) : []).toEqual([
      "standard",
      "fast",
    ]);
    const effort = descriptors.find((d) => d.id === "effort");
    expect(effort?.type === "select" ? effort.options.map((o) => o.id) : []).toEqual([
      "low",
      "high",
    ]);
  });

  it("emits a Default effort choice and Context select for bare-variant families", () => {
    const models = devinModelsFromCatalog({
      families: [
        {
          family_label: "GLM-5.2",
          family_uid: "glm-5.2",
          variants: [
            { model_uid: "glm-5-2" },
            { model_uid: "glm-5-2-max" },
            { model_uid: "glm-5-2-1m" },
            { model_uid: "glm-5-2-max-1m" },
            { model_uid: "glm-5-2-none" },
            { model_uid: "glm-5-2-none-1m" },
          ],
        },
      ],
    });
    const glm = models[0]!;
    const descriptors = glm.capabilities?.optionDescriptors ?? [];
    const effort = descriptors.find((d) => d.id === "effort");
    expect(effort?.type === "select" ? effort.options.map((o) => o.id) : []).toEqual([
      "default",
      "none",
      "max",
    ]);
    const context = descriptors.find((d) => d.id === "context");
    expect(context?.type === "select" ? context.options.map((o) => o.id) : []).toEqual([
      "200k",
      "1m",
    ]);
  });

  it("splits families whose variants parse to different bases", () => {
    const models = devinModelsFromCatalog({
      families: [
        {
          family_label: "Claude Sonnet 4.5",
          family_uid: "claude-sonnet-4.5",
          variants: [
            { model_uid: "MODEL_PRIVATE_2", label: "Claude Sonnet 4.5" },
            { model_uid: "MODEL_PRIVATE_3", label: "Claude Sonnet 4.5 Thinking" },
          ],
        },
      ],
    });
    expect(models.map((m) => m.slug)).toEqual(["model-private-2", "model-private-3"]);
    expect(models.map((m) => m.name)).toEqual(["Claude Sonnet 4.5", "Claude Sonnet 4.5 Thinking"]);
  });
});

describe("resolveDevinModelUid", () => {
  const advertised = [
    "swe-2-high",
    "swe-2-medium",
    "swe-2-max",
    "claude-opus-5-low",
    "claude-opus-5-high",
    "claude-opus-5-low-fast",
    "claude-opus-5-high-fast",
    "glm-5-2",
    "glm-5-2-max",
    "glm-5-2-1m",
    "adaptive",
  ];

  it("passes through exact uid matches", () => {
    expect(resolveDevinModelUid({ model: "swe-2-high", advertisedValues: advertised })).toBe(
      "swe-2-high",
    );
    expect(resolveDevinModelUid({ model: "swe-1-6-fast", advertisedValues: advertised })).toBe(
      "swe-1-6-fast",
    );
  });

  it("resolves effort selections to concrete uids", () => {
    expect(
      resolveDevinModelUid({
        model: "swe-2",
        selections: [{ id: "effort", value: "max" }],
        advertisedValues: advertised,
      }),
    ).toBe("swe-2-max");
  });

  it("combines effort and speed selections", () => {
    expect(
      resolveDevinModelUid({
        model: "claude-opus-5",
        selections: [
          { id: "effort", value: "low" },
          { id: "speed", value: "fast" },
        ],
        advertisedValues: advertised,
      }),
    ).toBe("claude-opus-5-low-fast");
    expect(
      resolveDevinModelUid({
        model: "claude-opus-5",
        selections: [
          { id: "effort", value: "high" },
          { id: "speed", value: "standard" },
        ],
        advertisedValues: advertised,
      }),
    ).toBe("claude-opus-5-high");
  });

  it("resolves the default effort to the bare variant", () => {
    expect(
      resolveDevinModelUid({
        model: "glm-5-2",
        selections: [{ id: "effort", value: "default" }],
        advertisedValues: advertised,
      }),
    ).toBe("glm-5-2");
    expect(
      resolveDevinModelUid({
        model: "glm-5-2",
        selections: [
          { id: "effort", value: "default" },
          { id: "context", value: "1m" },
        ],
        advertisedValues: advertised,
      }),
    ).toBe("glm-5-2-1m");
  });

  it("keeps the session's current value when no dims are selected", () => {
    expect(
      resolveDevinModelUid({
        model: "swe-2",
        advertisedValues: advertised,
        currentValue: "swe-2-high",
      }),
    ).toBe("swe-2-high");
  });

  it("relaxes to a matching effort when speed is unavailable", () => {
    expect(
      resolveDevinModelUid({
        model: "swe-2",
        selections: [
          { id: "effort", value: "max" },
          { id: "speed", value: "fast" },
        ],
        advertisedValues: advertised,
      }),
    ).toBe("swe-2-max");
  });

  it("does not let sibling families leak into each other", () => {
    const values = ["swe-1-7", "swe-1-7-medium", "swe-1-7-lightning", "swe-1-7-lightning-medium"];
    expect(
      resolveDevinModelUid({
        model: "swe-1-7",
        selections: [{ id: "effort", value: "medium" }],
        advertisedValues: values,
      }),
    ).toBe("swe-1-7-medium");
    expect(
      resolveDevinModelUid({
        model: "swe-1-7-lightning",
        advertisedValues: values,
      }),
    ).toBe("swe-1-7-lightning");
  });
});
