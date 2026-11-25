// @effect-diagnostics nodeBuiltinImport:off -- the worker takes a filesystem path.
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

it.each([
  {
    fixture: "epub-wide-table-cell",
    expected: [
      "## Chapter 1",
      "Wide",
      "Next row",
      "",
      "## Chapter 2",
      "Next chapter",
      "In range",
      "",
      "[Extracted text truncated at document extraction limits.]",
    ],
  },
  {
    fixture: "epub-row-and-column-spans",
    expected: [
      "## Chapter 1",
      "January\tFebruary\tMarch",
      "No sales\t\t420",
      "\t\t421",
      "January again",
      "Quarter\t\tTotal",
      "\t\t500",
      "New group",
      "New table",
    ],
  },
])("preserves EPUB table placement in $fixture", async ({ fixture, expected }) => {
  const path = NodeURL.fileURLToPath(new URL(`./fixtures/${fixture}.epub`, import.meta.url));
  expect(await extractDocumentText(path, ".epub")).toBe(expected.join("\n"));
});
