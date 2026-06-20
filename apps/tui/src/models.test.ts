import { describe, expect, it } from "bun:test";

import type { ServerProvider } from "@t3tools/contracts";
import { currentModelIndex, flattenModelOptions } from "./models.ts";

const provider = (
  instanceId: string,
  displayName: string,
  models: Array<{ slug: string; name: string; shortName?: string }>,
): ServerProvider =>
  ({
    instanceId,
    driver: instanceId,
    displayName,
    models: models.map((m) => ({ ...m, isCustom: false, capabilities: null })),
  }) as unknown as ServerProvider;

describe("flattenModelOptions", () => {
  it("Given providers with models, then it flattens them with labels", () => {
    const options = flattenModelOptions([
      provider("codex", "Codex", [{ slug: "gpt-5", name: "GPT-5", shortName: "5" }]),
      provider("claude", "Claude", [{ slug: "opus", name: "Opus 4" }]),
    ]);
    expect(options).toEqual([
      { instanceId: "codex", model: "gpt-5", label: "5", providerLabel: "Codex" },
      { instanceId: "claude", model: "opus", label: "Opus 4", providerLabel: "Claude" },
    ]);
  });

  it("Given a provider with no models, then it contributes nothing", () => {
    expect(flattenModelOptions([provider("empty", "Empty", [])])).toEqual([]);
  });
});

describe("currentModelIndex", () => {
  const options = flattenModelOptions([
    provider("codex", "Codex", [{ slug: "gpt-5", name: "GPT-5" }]),
    provider("claude", "Claude", [{ slug: "opus", name: "Opus" }]),
  ]);

  it("finds the index of the matching selection", () => {
    expect(currentModelIndex(options, { instanceId: "claude", model: "opus" })).toBe(1);
  });

  it("falls back to 0 when nothing matches or no selection", () => {
    expect(currentModelIndex(options, { instanceId: "x", model: "y" })).toBe(0);
    expect(currentModelIndex(options, null)).toBe(0);
  });
});
