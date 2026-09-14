import { describe, expect, it } from "vite-plus/test";

import {
  buildOmpModelCapabilities,
  catalogFromOmpModelEntries,
  decodeOmpModelCatalog,
} from "./OmpModelCatalog.ts";

/**
 * Trimmed copies of real `get_available_models` entries (omp/18.1.18): a
 * 200,000-token non-reasoning model, a 1,000,000-token adaptive model and an
 * `effort` model whose ladder starts at `medium`, all in one catalog.
 */
const ompModelEntries = [
  {
    id: "claude-3-5-sonnet-20240620",
    name: "Claude Sonnet 3.5",
    provider: "anthropic",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 8192,
    identity: { class: "anthropic", family: "sonnet", revision: "3.5.0" },
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    provider: "anthropic",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinking: {
      mode: "anthropic-adaptive",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      supportsDisplay: true,
    },
  },
  {
    id: "glm-5.3",
    name: "GLM 5.3",
    provider: "opencode-go",
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "max" },
  },
] as const;

const rpcTranscript = [
  // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frames.
  JSON.stringify({ type: "ready" }),
  // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frames.
  JSON.stringify({
    type: "available_commands_update",
    commands: [{ name: "compact", description: "Compact the context" }],
  }),
  "not json",
  // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frames.
  JSON.stringify({
    type: "response",
    command: "get_available_models",
    data: { models: ompModelEntries },
  }),
].join("\n");

describe("catalogFromOmpModelEntries", () => {
  it("reports each model's own context window, not one session-wide value", () => {
    const catalog = catalogFromOmpModelEntries(ompModelEntries);

    expect(
      [...catalog.metadataBySlug.values()].map((entry) => [entry.slug, entry.contextWindow]),
    ).toEqual([
      ["anthropic/claude-3-5-sonnet-20240620", 200_000],
      ["anthropic/claude-fable-5", 1_000_000],
      ["opencode-go/glm-5.3", 204_800],
    ]);
    expect(catalog.metadataBySlug.get("anthropic/claude-fable-5")).toEqual({
      slug: "anthropic/claude-fable-5",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("keys models by the ACP slug omp accepts and labels the upstream provider", () => {
    const catalog = catalogFromOmpModelEntries(ompModelEntries);

    // The ACP `model` select advertises `<provider>/<id>`; the bare
    // `get_available_models` id is not a value omp would accept back.
    expect(catalog.models.map((model) => model.slug)).toEqual([
      "anthropic/claude-fable-5",
      "anthropic/claude-3-5-sonnet-20240620",
      "opencode-go/glm-5.3",
    ]);
    expect(catalog.models.map((model) => model.subProvider)).toEqual([
      "Anthropic",
      "Anthropic",
      "Opencode Go",
    ]);
    expect(catalog.models.every((model) => model.isCustom)).toBe(false);
  });

  it("offers each model its own reasoning ladder plus omp's off and auto", () => {
    const catalog = catalogFromOmpModelEntries(ompModelEntries);
    const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));

    expect(bySlug.get("anthropic/claude-fable-5")?.capabilities).toEqual({
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Thinking",
          type: "select",
          options: [
            { id: "off", label: "Off" },
            { id: "auto", label: "Auto" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Max" },
          ],
        },
      ],
    });
    // A narrower ladder must not gain levels from its catalog neighbours, and
    // omp's own `defaultLevel` decides the picker's current value.
    expect(bySlug.get("opencode-go/glm-5.3")?.capabilities).toEqual({
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Thinking",
          type: "select",
          currentValue: "max",
          options: [
            { id: "off", label: "Off" },
            { id: "auto", label: "Auto" },
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
            { id: "max", label: "Max", isDefault: true },
          ],
        },
      ],
    });
  });

  it("reports no reasoning levels for a model omp calls non-reasoning", () => {
    const catalog = catalogFromOmpModelEntries(ompModelEntries);
    const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));

    expect(
      catalog.metadataBySlug.get("anthropic/claude-3-5-sonnet-20240620")?.reasoningEfforts,
    ).toEqual([]);
    expect(bySlug.get("anthropic/claude-3-5-sonnet-20240620")?.capabilities).toEqual({
      optionDescriptors: [],
    });
  });

  it("drops ladder values T3 cannot write back and duplicate slugs", () => {
    const catalog = catalogFromOmpModelEntries([
      {
        id: "future-model",
        name: "Future",
        provider: "acme",
        reasoning: true,
        thinking: { mode: "effort", efforts: ["low", "ludicrous", "extra-high"] },
      },
      { id: "future-model", name: "Future (again)", provider: "acme", reasoning: false },
      { name: "no id", provider: "acme" },
    ]);

    expect(catalog.models.map((model) => model.name)).toEqual(["Future"]);
    expect(catalog.metadataBySlug.get("acme/future-model")?.reasoningEfforts).toEqual([
      "low",
      "xhigh",
    ]);
  });
});

describe("buildOmpModelCapabilities", () => {
  it("emits no descriptor at all when there is no ladder", () => {
    expect(buildOmpModelCapabilities({ reasoningEfforts: [] })).toEqual({ optionDescriptors: [] });
  });
});

describe("decodeOmpModelCatalog", () => {
  it("reads the model response out of a mixed RPC transcript", () => {
    const catalog = decodeOmpModelCatalog(rpcTranscript);

    expect(catalog.models).toHaveLength(3);
    expect(catalog.metadataBySlug.get("anthropic/claude-fable-5")?.contextWindow).toBe(1_000_000);
  });

  it("returns an empty catalog when omp answered no model response", () => {
    // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
    const catalog = decodeOmpModelCatalog(JSON.stringify({ type: "ready" }));

    expect(catalog.models).toEqual([]);
    expect(catalog.metadataBySlug.size).toBe(0);
  });
});
