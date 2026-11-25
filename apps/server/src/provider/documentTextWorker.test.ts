import { expect, it } from "vite-plus/test";
import * as NodeURL from "node:url";
import { extractDocumentText } from "./documentTextWorker.ts";

it.each([
  ["wide-heading", "Heading\nAfter the table"],
  ["wide-empty-merge", "Heading\nNext row\nAfter the table"],
  [
    "wide-heading-with-overflow",
    "Heading\n\n[Extracted text truncated at document extraction limits.]",
  ],
])("extracts text within the EPUB column limit from %s", async (fixture, expected) => {
  const path = NodeURL.fileURLToPath(new URL(`./fixtures/${fixture}.epub`, import.meta.url));
  expect(await extractDocumentText(path, ".epub")).toBe(`## Chapter 1\n${expected}`);
});
