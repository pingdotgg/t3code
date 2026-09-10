import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../providerInstances";
import {
  findInitialForkModelSelection,
  isForkModelSelectionReady,
  isSameForkModelSelection,
} from "./ForkThreadDialog.logic";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

function provider(input: {
  instanceId: ProviderInstanceId;
  driver: "codex" | "claudeAgent";
  models: ReadonlyArray<string>;
  status?: "ready" | "error";
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: ProviderDriverKind.make(input.driver),
    displayName: null,
    accentColor: null,
    enabled: true,
    installed: true,
    availability: "available",
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    models: input.models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
  } as unknown as ServerProvider;
}

describe("fork model selection", () => {
  it("selects the first ready provider/model pair that differs from the source", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ instanceId: codex, driver: "codex", models: ["gpt-5.6", "gpt-5.5"] }),
      provider({ instanceId: claude, driver: "claudeAgent", models: ["claude-opus"] }),
    ]);
    const options = new Map([
      [
        codex,
        [
          { slug: "gpt-5.6", name: "GPT-5.6", isCustom: false },
          { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false },
        ],
      ],
      [claude, [{ slug: "claude-opus", name: "Claude Opus", isCustom: false }]],
    ]);

    expect(
      findInitialForkModelSelection({
        source: { instanceId: codex, model: "gpt-5.6" },
        entries,
        modelOptionsByInstance: options,
      }),
    ).toEqual({ instanceId: claude, model: "claude-opus" });
  });

  it("skips providers that cannot currently start a session", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        instanceId: claude,
        driver: "claudeAgent",
        models: ["claude-opus"],
        status: "error",
      }),
    ]);
    const options = new Map([
      [claude, [{ slug: "claude-opus", name: "Claude Opus", isCustom: false }]],
    ]);

    expect(
      findInitialForkModelSelection({
        source: { instanceId: codex, model: "gpt-5.6" },
        entries,
        modelOptionsByInstance: options,
      }),
    ).toBeNull();
  });

  it("compares both provider instance and model", () => {
    expect(
      isSameForkModelSelection(
        { instanceId: codex, model: "gpt-5.6" },
        { instanceId: codex, model: "gpt-5.6" },
      ),
    ).toBe(true);
    expect(
      isSameForkModelSelection(
        { instanceId: codex, model: "gpt-5.6" },
        { instanceId: claude, model: "gpt-5.6" },
      ),
    ).toBe(false);
  });

  it("rejects a selection when its provider or model stops being available", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ instanceId: claude, driver: "claudeAgent", models: ["claude-opus"] }),
    ]);
    const selection = { instanceId: claude, model: "claude-opus" };

    expect(
      isForkModelSelectionReady({
        selection,
        entries,
        modelOptionsByInstance: new Map([
          [claude, [{ slug: "claude-opus", name: "Claude Opus", isCustom: false }]],
        ]),
      }),
    ).toBe(true);
    expect(
      isForkModelSelectionReady({
        selection,
        entries,
        modelOptionsByInstance: new Map([
          [
            claude,
            [
              {
                slug: "claude-opus",
                name: "Claude Opus",
                isCustom: false,
                isUnavailable: true,
              },
            ],
          ],
        ]),
      }),
    ).toBe(false);
  });
});
