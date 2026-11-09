import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { HIGHLIGHTS_LANGUAGE_IDS, HIGHLIGHTS_THEME_STYLES } from "../src/lib/highlights.generated";
import { computeHighlightsData } from "./generate-highlights.mts";

describe("generate highlights", () => {
  // Token and language IDs are the native build's ABI. Bumping
  // @pierre/highlights without regenerating would mislabel every token.
  it("matches the installed @pierre/highlights", async () => {
    const data = await computeHighlightsData();
    const nativeSource = NodeFS.readFileSync(
      NodePath.resolve(
        import.meta.dirname,
        "../modules/t3-highlights/Vendor/highlights/highlights.c",
      ),
      "utf8",
    );

    const stale = "Stale. Run WASM2C=<wabt 1.0.42>/bin/wasm2c vp run generate:highlights.";
    expect(HIGHLIGHTS_LANGUAGE_IDS, stale).toEqual(data.languageIds);
    expect(HIGHLIGHTS_THEME_STYLES, stale).toEqual(data.themeStyles);
    expect(nativeSource.slice(0, nativeSource.indexOf("\n")), stale).toContain(
      data.source.wasmSha256,
    );
  });
});
