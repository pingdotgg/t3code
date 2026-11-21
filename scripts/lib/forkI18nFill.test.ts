import { describe, expect, it } from "vite-plus/test";

import { fillForkCatalogs } from "./forkI18nFill.ts";

describe("fillForkCatalogs", () => {
  it("drops stale keys, appends new ones, and fills locales with the English text", () => {
    const result = fillForkCatalogs({
      source: { a1: "Open", b2: "Gone", c3: "Close" },
      generatedSource: { c3: "Close", a1: "Open", d4: "Depends on" },
      locales: { de: { a1: "Öffnen", b2: "Weg", c3: "Schließen" } },
    });

    expect(Object.entries(result.source)).toEqual([
      ["a1", "Open"],
      ["c3", "Close"],
      ["d4", "Depends on"],
    ]);
    expect(Object.entries(result.locales.de!)).toEqual([
      ["a1", "Öffnen"],
      ["c3", "Schließen"],
      ["d4", "Depends on"],
    ]);
    expect(result.added).toEqual(["d4"]);
    expect(result.removed).toEqual(["b2"]);
  });

  it("takes the generated text when a kept key's catalog text drifted", () => {
    const result = fillForkCatalogs({
      source: { a1: ["Open ", { i: 1 }] },
      generatedSource: { a1: ["Open", { i: 1 }] },
      locales: {},
    });

    expect(result.source).toEqual({ a1: ["Open", { i: 1 }] });
  });
});
