import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { hasDismissedResumeCompaction } from "@t3tools/client-runtime/state/context-window";
import { contextWindowSegments, hasAvailableCompactionProvider } from "./compaction.logic";

describe("contextWindowSegments", () => {
  const usage = {
    usedTokens: 1_000,
    inputTokens: 800,
    cachedInputTokens: 600,
    outputTokens: 200,
    reasoningOutputTokens: 150,
  };
  const breakdown = (input: Parameters<typeof contextWindowSegments>[0]) =>
    contextWindowSegments(input).map(({ label, tokens }) => [label, tokens]);

  it("counts cache and reasoning once within their parent totals", () => {
    expect(breakdown(usage)).toEqual([
      ["Cached input", 600],
      ["New input", 200],
      ["Output", 50],
      ["Reasoning", 150],
    ]);
  });

  it("shows one segment when only used context is reported, including after compaction", () => {
    expect(
      breakdown({
        usedTokens: 1_000,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
      }),
    ).toEqual([["Used context", 1_000]]);
    expect(
      breakdown({
        ...usage,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      }),
    ).toEqual([["Used context", 1_000]]);
  });

  it("keeps unclassified context instead of inflating reported categories", () => {
    expect(breakdown({ ...usage, usedTokens: 1_200 })).toEqual([
      ["Cached input", 600],
      ["New input", 200],
      ["Output", 50],
      ["Reasoning", 150],
      ["Other context", 200],
    ]);
  });

  it("shows a provider's own categories largest first, without empty ones", () => {
    expect(
      breakdown({
        ...usage,
        breakdown: [
          { kind: "system_prompt", tokens: 300 },
          { kind: "skills", tokens: 0 },
          { kind: "messages", tokens: 500 },
          { kind: "t3_tools", tokens: 200 },
        ],
      }),
    ).toEqual([
      ["Messages", 500],
      ["System prompt", 300],
      ["T3 Code tools", 200],
    ]);
  });

  it("caps subsets at their parent and total context", () => {
    expect(
      breakdown({ ...usage, usedTokens: 900, cachedInputTokens: 900, reasoningOutputTokens: 300 }),
    ).toEqual([
      ["Cached input", 800],
      ["Reasoning", 100],
    ]);
  });
});

function claudeProvider(input: {
  instanceId: string;
  continuationGroupKey: string;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: input.continuationGroupKey },
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: [{ name: "compact", description: "" }],
    skills: [],
  };
}

describe("hasAvailableCompactionProvider", () => {
  const originalInstanceId = ProviderInstanceId.make("claude_original");

  it("rejects a fallback in a different locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_other",
        continuationGroupKey: "claude:home:/other",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(false);
  });

  it("accepts an enabled fallback in the locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_fallback",
        continuationGroupKey: "claude:home:/original",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(true);
  });
});

describe("hasDismissedResumeCompaction", () => {
  it("recognizes the native resume dialog's permanent dismissal", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is 2h 0m old and uses 250,000 tokens. Compact it before continuing?":
                "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("ignores unrelated questions that end with Claude's compaction prompt", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "The build cache is large. Compact it before continuing?": "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(false);
  });
});
