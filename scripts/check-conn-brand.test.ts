// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { catalogBrandHits, catalogFiles } from "./conn-brand.ts";

describe("catalogBrandHits", () => {
  it("reports plain and JSX entries that name the app literally", () => {
    const hits = catalogBrandHits("de.json", {
      plain: "T3 Code startet neu.",
      compound: "Aktualisiere den T3-Code-Server.",
      jsx: ["Öffne ", { t: "code", i: 1, c: "T3 Code" }, "."],
      placeholder: "{appName} startet neu.",
      jsxPlaceholder: ["Öffne ", { i: 1, k: "_gt_value_1", v: "v" }, "."],
    });
    expect(hits.map((hit) => hit.key)).toEqual(["plain", "compound", "jsx"]);
  });

  it("passes on the committed catalogs", async () => {
    const NodeFS = await import("node:fs");
    const root = NodePath.resolve(import.meta.dirname, "..");
    const hits = catalogFiles(root).flatMap((file) =>
      catalogBrandHits(file, JSON.parse(NodeFS.readFileSync(file, "utf8"))),
    );
    expect(hits).toEqual([]);
  });
});
