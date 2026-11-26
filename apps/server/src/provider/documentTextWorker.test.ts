// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

it("omits the output heading when only half an emoji fits after it", async () => {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-notebook-budget-"));
  try {
    const path = NodePath.join(folder, "output.ipynb");
    const source = "x".repeat(1_000_000 - "## Cell 1 (code)\n".length - "\nOutput:\n".length - 1);
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        cells: [{ cell_type: "code", source, outputs: [{ output_type: "stream", text: "😀" }] }],
      }),
    );
    const extracted = await extractDocumentText(path, ".ipynb");
    expect(extracted.slice(source.length + "## Cell 1 (code)\n".length)).toBe(
      "\n\n[Extracted text truncated at document extraction limits.]",
    );
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});
