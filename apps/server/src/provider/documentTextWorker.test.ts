// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

const cellHeading = "## Cell 1 (code)\n";
const outputHeading = "\nOutput:\n";

it.each([
  {
    name: "omits the output heading when only half an emoji fits after it",
    source: "x".repeat(1_000_000 - cellHeading.length - outputHeading.length - 1),
    outputs: ["😀"],
    remainder: "\n\n[Extracted text truncated at document extraction limits.]",
  },
  {
    name: "keeps reading after a high surrogate in an output below the limit",
    source: "run()",
    outputs: ["\uD83D", "\uDE00"],
    remainder: "\nOutput:\n\uD83D\n\uDE00\n\n## Cell 2 (markdown)\nLater cell",
  },
])("$name", async ({ source, outputs, remainder }) => {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-notebook-budget-"));
  try {
    const path = NodePath.join(folder, "output.ipynb");
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source,
            outputs: outputs.map((text) => ({ output_type: "stream", text })),
          },
          { cell_type: "markdown", source: "Later cell" },
        ],
      }),
    );
    const extracted = await extractDocumentText(path, ".ipynb");
    expect(extracted.slice(source.length + cellHeading.length)).toBe(remainder);
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});
