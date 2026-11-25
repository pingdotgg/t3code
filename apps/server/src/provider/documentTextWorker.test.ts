// @effect-diagnostics nodeBuiltinImport:off -- resolve a local fixture for the document worker.
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

it("preserves soft hyphens without letting inline EPUB image descriptions touch words", async () => {
  const path = NodeURL.fileURLToPath(
    new URL("./fixtures/inline-image-soft-hyphens.epub", import.meta.url),
  );
  expect(await extractDocumentText(path, ".epub")).toBe(
    "## Chapter 1\nBoard\u00ad Anchor symbol \u00adhere.\nDock \u00adAnchor\u00ad now.\nStop!\u00adAnchor.",
  );
});
