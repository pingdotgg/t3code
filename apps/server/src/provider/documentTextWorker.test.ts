// @effect-diagnostics nodeBuiltinImport:off -- temporary notebook fixture for the CLI worker.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

it("extracts notebook Markdown when the plain-text output contains only NUL", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-notebook-"));
  try {
    const path = NodePath.join(directory, "output.ipynb");
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            outputs: [
              {
                output_type: "display_data",
                data: { "text/plain": "\0", "text/markdown": "**Complete**" },
              },
            ],
          },
        ],
      }),
    );
    expect(await extractDocumentText(path, ".ipynb")).toContain("**Complete**");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
