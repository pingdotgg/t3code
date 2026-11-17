import { describe, expect, it, vi } from "vite-plus/test";

import {
  collectComposerModelMentions,
  formatComposerModelMention,
  rankComposerModelMentions,
} from "./composerModelMentions.ts";

const models = [
  { id: "traex:gpt", name: "GPT-6.1", driverKind: "codex", providerDisplayName: "Traex" },
  {
    id: "opencode:traex-gpt",
    name: "GPT-6.1",
    subProvider: "Traex",
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
  },
  {
    id: "opencode:opus",
    name: "Claude Opus 5.5",
    subProvider: "Anthropic",
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
  },
  {
    id: "claude:opus",
    name: "Claude Opus 5.5",
    driverKind: "claudeAgent",
    providerDisplayName: "Claude",
  },
];

function rank(query: string): string[] {
  return rankComposerModelMentions(models, query, (model) => model).map((model) => model.id);
}

describe("rankComposerModelMentions", () => {
  it.each(["", "-", "---", ":/-/:"])(
    "offers no models for a bare or separator-only @%s",
    (query) => {
      expect(rank(query)).toEqual([]);
    },
  );

  it("finds a model under every provider that serves it", () => {
    expect(rank("gpt").toSorted()).toEqual(["opencode:traex-gpt", "traex:gpt"]);
  });

  it("splits words a mention joins with :, / or -", () => {
    expect(rank("opencode:traex")).toEqual(["opencode:traex-gpt"]);
    expect(rank("opencode/gpt")).toEqual(["opencode:traex-gpt"]);
    expect(rank("opencode-gpt")).toEqual(["opencode:traex-gpt"]);
  });

  it("keeps a hyphenated model name whole when it matches", () => {
    expect(rank("gpt-6.1").toSorted()).toEqual(["opencode:traex-gpt", "traex:gpt"]);
  });

  it.each(["src", "g", "agent", "pus"])(
    "does not offer models whose words only contain @%s",
    (query) => {
      expect(rank(query)).toEqual([]);
    },
  );
});

describe("collectComposerModelMentions", () => {
  it("reads back what formatComposerModelMention writes, inside prose", () => {
    const text = `use ${formatComposerModelMention("opencode", "anthropic/opus")}, then model:codex/gpt-5.4.`;
    expect(collectComposerModelMentions(text)).toEqual([
      {
        instanceId: "opencode",
        model: "anthropic/opus",
        options: [],
        source: "model:opencode/anthropic/opus",
        start: 4,
        end: 33,
      },
      {
        instanceId: "codex",
        model: "gpt-5.4",
        options: [],
        source: "model:codex/gpt-5.4",
        start: 40,
        end: 59,
      },
    ]);
  });

  it("reads back the options a mention carries", () => {
    const options = [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "fastMode", value: true },
      { id: "contextWindow", value: "1m & more" },
    ];
    const source = formatComposerModelMention("codex", "gpt-6.1-sol", options);
    expect(source).toBe(
      "model:codex/gpt-6.1-sol?reasoningEffort=xhigh&fastMode=true&contextWindow=1m%20%26%20more",
    );
    expect(collectComposerModelMentions(`ask ${source}.`)).toEqual([
      {
        instanceId: "codex",
        model: "gpt-6.1-sol",
        options,
        source,
        start: 4,
        end: 4 + source.length,
      },
    ]);
  });

  it("keeps a mention's model when its options are malformed", () => {
    expect(
      collectComposerModelMentions("model:codex/gpt-6.1?effort=low&=x&fast&bad=%E0%A4%A"),
    ).toMatchObject([{ model: "gpt-6.1", options: [{ id: "effort", value: "low" }] }]);
  });

  it.each([
    ["(model:codex/gpt-6.1).", ["codex/gpt-6.1"]],
    ['"model:codex/gpt-6.1"', ["codex/gpt-6.1"]],
    ["model:codex/gpt-6.1,model:claudeAgent/sonnet", ["codex/gpt-6.1", "claudeAgent/sonnet"]],
    ["model:codex/gpt-6.1's output", ["codex/gpt-6.1"]],
    ["model:opencode/foo(bar)", ["opencode/foo(bar)"]],
    ["(model:codex/GPT-6.1-Sol[1m]).", ["codex/GPT-6.1-Sol[1m]"]],
    ["model:codex/gpt-6.1" + ")".repeat(128), ["codex/gpt-6.1"]],
  ])("bounds the reference in %s", (text, expected) => {
    const { mentions, rescans } = (() => {
      using split = vi.spyOn(String.prototype, "split");
      const mentions = collectComposerModelMentions(text);
      return { mentions, rescans: split.mock.calls.length };
    })();
    expect(mentions.map(({ instanceId, model }) => `${instanceId}/${model}`)).toEqual(expected);
    expect(rescans).toBeLessThanOrEqual(expected.length * 4);
  });

  it.each(["remodel:codex/gpt", "model:codex", "model:/gpt", "model:codex/.", "model:1x/gpt"])(
    "ignores %s",
    (text) => {
      expect(collectComposerModelMentions(text)).toEqual([]);
    },
  );
});
