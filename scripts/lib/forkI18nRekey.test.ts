import { describe, expect, it } from "vite-plus/test";

import { rekeyForkCatalogs } from "./forkI18nRekey.ts";

describe("rekeyForkCatalogs", () => {
  it("moves each locale entry to the key of its renamed source text", () => {
    const result = rekeyForkCatalogs({
      renamedSource: { a1: "Restart Lathe?", b2: "Open settings", c3: ["Lathe ", { i: 1 }] },
      generatedSource: { z9: "Restart Lathe?", b2: "Open settings", y8: ["Lathe ", { i: 1 }] },
      locales: {
        de: { a1: "Lathe neu starten?", b2: "Einstellungen öffnen", c3: ["Lathe ", { i: 1 }] },
      },
    });

    expect(result.problems).toEqual([]);
    expect(result.moved).toEqual({ a1: "z9", c3: "y8" });
    expect(Object.keys(result.source)).toEqual(["z9", "b2", "y8"]);
    expect(Object.entries(result.locales.de!)).toEqual([
      ["z9", "Lathe neu starten?"],
      ["b2", "Einstellungen öffnen"],
      ["y8", ["Lathe ", { i: 1 }]],
    ]);
  });

  it("refuses to pair a stale key when its renamed text matches several new keys", () => {
    const result = rekeyForkCatalogs({
      renamedSource: { a1: "Lathe" },
      generatedSource: { x1: "Lathe", x2: "Lathe" },
      locales: { de: { a1: "Lathe" } },
    });

    expect(result.problems).toEqual(['a1 "Lathe" matches 2 new keys (x1, x2); pair them by hand']);
  });

  it("reports source entries the rename left without a new key", () => {
    const result = rekeyForkCatalogs({
      renamedSource: { a1: "Gone", b2: "Kept" },
      generatedSource: { b2: "Kept", c3: "New text" },
      locales: { de: { a1: "Weg", b2: "Bleibt" } },
    });

    expect(result.problems).toEqual([
      'a1 "Gone" has no new key',
      'c3 "New text" is new in the source, not a rename',
    ]);
  });

  it("reports a kept key whose generated text differs from the renamed catalog", () => {
    const result = rekeyForkCatalogs({
      renamedSource: { a1: "Restart Lathe?" },
      generatedSource: { a1: "Restart T3 Code?" },
      locales: {},
    });

    expect(result.problems).toEqual([
      'a1: catalog says "Restart Lathe?", source says "Restart T3 Code?"',
    ]);
  });
});
