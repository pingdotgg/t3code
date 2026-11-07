import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerModelItems } from "./composerModelMentions";
import type { ModelEsque } from "./providerIconUtils";

const traex = {
  instanceId: ProviderInstanceId.make("traex"),
  driverKind: ProviderDriverKind.make("codex"),
  displayName: "Traex",
  acpRegistryAgentId: undefined,
  acpRegistryIconUrl: undefined,
  continuationGroupKey: undefined,
  enabled: true,
  isAvailable: true,
  status: "ready" as const,
};
const opencode = {
  ...traex,
  instanceId: ProviderInstanceId.make("opencode"),
  driverKind: ProviderDriverKind.make("opencode"),
  displayName: "OpenCode",
};
const claude = {
  ...traex,
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
};

const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
  [
    traex.instanceId,
    [
      { slug: "gpt-6.1", name: "GPT-6.1" },
      { slug: "gpt-5", name: "GPT-5", isLegacy: true },
    ],
  ],
  [
    opencode.instanceId,
    [
      { slug: "traex/gpt-6.1", name: "GPT-6.1", subProvider: "Traex" },
      { slug: "anthropic/opus", name: "Claude Opus 5.5", subProvider: "Anthropic" },
    ],
  ],
  [claude.instanceId, [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }]],
]);

function match(
  query: string,
  overrides: Partial<Parameters<typeof matchComposerModelItems>[0]> = {},
): string[] {
  return matchComposerModelItems({
    instanceEntries: [traex, opencode, claude],
    modelOptionsByInstance,
    query,
    ...overrides,
  }).map((item) => `${item.instanceId}:${item.model}`);
}

describe("matchComposerModelItems", () => {
  it("finds a current model under every provider that serves it, skipping legacy ones", () => {
    expect(match("gpt").toSorted()).toEqual(["opencode:traex/gpt-6.1", "traex:gpt-6.1"]);
  });

  it("leaves out providers that are not ready", () => {
    expect(
      match("gpt", { instanceEntries: [{ ...traex, status: "error" as const }, opencode] }),
    ).toEqual(["opencode:traex/gpt-6.1"]);
  });
});
