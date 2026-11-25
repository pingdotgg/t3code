// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

it("separates EPUB lists from preceding text only when they contain visible text", async () => {
  const path = NodeURL.fileURLToPath(
    new URL("./fixtures/epub-list-boundaries.epub", import.meta.url),
  );
  const text = await extractDocumentText(path, ".epub");

  for (const expected of [
    "Intro\nRead the checklist",
    "Requirements\nPhoto",
    "Carry\nPassport\nRequired",
    "Leave room",
    "Keep walking",
    "Before departure\nCheck gate",
  ]) {
    expect(text).toContain(expected);
  }
});
