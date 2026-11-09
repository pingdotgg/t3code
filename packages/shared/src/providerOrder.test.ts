import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  firstProviderOrderSettings,
  providerDriverOrder,
  sortByProviderOrder,
} from "./providerOrder.ts";

const ids = (...values: string[]) => values.map((value) => ProviderInstanceId.make(value));

describe("sortByProviderOrder", () => {
  it.each([
    {
      name: "puts listed ids first and keeps the rest in incoming order",
      items: ["codex", "claudeAgent", "cursor", "grok"],
      order: ["grok", "codex"],
      expected: ["grok", "codex", "claudeAgent", "cursor"],
    },
    {
      name: "skips missing ids and ranks repeats by their first position",
      items: ["codex", "claudeAgent"],
      order: ["gone", "claudeAgent", "codex", "claudeAgent"],
      expected: ["claudeAgent", "codex"],
    },
  ])("$name", ({ items, order, expected }) => {
    expect(sortByProviderOrder(items, order, (id) => id)).toEqual(expected);
  });
});

describe("providerDriverOrder", () => {
  it("maps custom instances to their driver", () => {
    expect(
      providerDriverOrder({
        providerInstances: {
          [ProviderInstanceId.make("codex_work")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            config: {},
          },
        },
        providerOrder: ids("grok", "codex_work", "claudeAgent"),
      }),
    ).toEqual(["grok", "codex", "claudeAgent"]);
  });
});

describe("firstProviderOrderSettings", () => {
  it("returns the first environment that saved an order", () => {
    const saved = { ...DEFAULT_SERVER_SETTINGS, providerOrder: ids("grok") };

    expect(firstProviderOrderSettings([null, DEFAULT_SERVER_SETTINGS, saved])).toBe(saved);
    expect(firstProviderOrderSettings([DEFAULT_SERVER_SETTINGS])).toBeNull();
  });
});
