// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

it.each([
  { roomForOutput: 1, output: "😀", expectedOutput: "" },
  { roomForOutput: 2, output: "😀", expectedOutput: "\nOutput:\n😀" },
  { roomForOutput: 2, output: "A😀", expectedOutput: "\nOutput:\nA" },
])(
  "extracts $output with $roomForOutput UTF-16 units left after the heading",
  async ({ roomForOutput, output, expectedOutput }) => {
    const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-notebook-budget-"));
    try {
      const path = NodePath.join(folder, "output.ipynb");
      const source = "x".repeat(
        1_000_000 - "## Cell 1 (code)\n".length - "\nOutput:\n".length - roomForOutput,
      );
      await NodeFSP.writeFile(
        path,
        JSON.stringify({
          cells: [
            { cell_type: "code", source, outputs: [{ output_type: "stream", text: output }] },
          ],
        }),
      );
      const truncated = "\n\n[Extracted text truncated at document extraction limits.]";
      const extracted = await extractDocumentText(path, ".ipynb");
      expect(extracted.slice(source.length + "## Cell 1 (code)\n".length)).toBe(
        expectedOutput + truncated,
      );
    } finally {
      await NodeFSP.rm(folder, { recursive: true, force: true });
    }
  },
);
