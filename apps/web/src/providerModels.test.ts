import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderDriverKindLabel,
  getProviderModelCapabilities,
  resolveThreadProviderDisplayName,
} from "./providerModels";

const PROVIDER = ProviderDriverKind.make("claudeAgent");

function capabilities(id: string): ModelCapabilities {
  return {
    optionDescriptors: [{ id, label: id, type: "boolean" }],
  };
}

function model(input: {
  slug: string;
  capabilities: ModelCapabilities;
  aliases?: ReadonlyArray<string>;
  isCustom?: boolean;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    ...(input.aliases ? { aliases: [...input.aliases] } : {}),
    isCustom: input.isCustom ?? false,
    capabilities: input.capabilities,
  };
}

describe("getProviderModelCapabilities", () => {
  it("resolves model-declared aliases", () => {
    const aliasCapabilities = capabilities("aliased-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["Legacy-Synthetic-Model"],
        capabilities: aliasCapabilities,
      }),
    ];

    expect(getProviderModelCapabilities(models, "legacy-synthetic-model", PROVIDER)).toEqual(
      aliasCapabilities,
    );
  });

  it("prefers an exact custom slug over a built-in model alias", () => {
    const customCapabilities = capabilities("custom-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["custom-model"],
        capabilities: capabilities("built-in-option"),
      }),
      model({ slug: "custom-model", capabilities: customCapabilities, isCustom: true }),
    ];

    expect(getProviderModelCapabilities(models, " custom-model ", PROVIDER)).toEqual(
      customCapabilities,
    );
  });

  it("returns empty capabilities for an unknown slug", () => {
    const models = [
      model({
        slug: "default-model",
        capabilities: capabilities("default-option"),
      }),
    ];

    expect(getProviderModelCapabilities(models, "unknown-model", PROVIDER)).toEqual({
      optionDescriptors: [],
    });
  });
});

describe("formatProviderDriverKindLabel", () => {
  it("maps the omp slug to its configured display name", () => {
    expect(formatProviderDriverKindLabel(ProviderDriverKind.make("omp"))).toBe("Oh My Pi");
  });

  it("maps the legacy piAgent slug to the same display name", () => {
    expect(formatProviderDriverKindLabel(ProviderDriverKind.make("piAgent"))).toBe("Oh My Pi");
  });

  it("prefers brand labels over humanized slugs for every driver", () => {
    expect(formatProviderDriverKindLabel(ProviderDriverKind.make("claudeAgent"))).toBe("Claude");
    expect(formatProviderDriverKindLabel(ProviderDriverKind.make("opencode"))).toBe("OpenCode");
    expect(formatProviderDriverKindLabel(ProviderDriverKind.make("codex"))).toBe("Codex");
  });

  it("humanizes an unmapped fork slug", () => {
    expect(formatProviderDriverKindLabel(ProviderDriverKind.make("myCustomDriver"))).toBe(
      "My Custom Driver",
    );
  });
});

describe("resolveThreadProviderDisplayName", () => {
  it("prefers the configured display name over the driver slug", () => {
    expect(
      resolveThreadProviderDisplayName({
        configuredDisplayName: "Oh My Pi",
        sessionProviderName: "omp",
        fallbackInstanceId: "omp",
      }),
    ).toBe("Oh My Pi");
  });

  it("formats the session slug when no catalog entry exists", () => {
    expect(resolveThreadProviderDisplayName({ sessionProviderName: "omp" })).toBe("Oh My Pi");
    expect(resolveThreadProviderDisplayName({ sessionProviderName: "piAgent" })).toBe("Oh My Pi");
  });

  it("humanizes an unmapped slug without a configured name", () => {
    expect(resolveThreadProviderDisplayName({ fallbackInstanceId: "my_custom" })).toBe("My Custom");
  });
});
