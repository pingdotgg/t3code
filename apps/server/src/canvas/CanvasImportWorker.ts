// @effect-diagnostics nodeBuiltinImport:off
// This CLI subprocess deliberately runs outside the server Effect runtime.
import * as NodeFSP from "node:fs/promises";
import { CanvasAsset, CanvasNode } from "@t3tools/contracts";
import { importCanvasFile } from "@t3tools/shared/canvasImport";
import * as Schema from "effect/Schema";

const isNode = Schema.is(CanvasNode);
const isAsset = Schema.is(CanvasAsset);

/** Stream JSON to disk so the decoded graph never coexists with one giant JSON string. */
export async function runCanvasImportWorker(args: ReadonlyArray<string>): Promise<void> {
  const [input, output, fileName] = args;
  if (!input || !output || !fileName) throw new Error("Missing canvas import arguments");
  const result = await importCanvasFile(fileName, new Uint8Array(await NodeFSP.readFile(input)));
  const file = await NodeFSP.open(output, "wx");
  let written = 0;
  let bufferedBytes = 0;
  let parts: string[] = [];
  const write = (value: string): Promise<void> | undefined => {
    const bytes = Buffer.byteLength(value);
    written += bytes;
    if (written > 128 * 1024 * 1024)
      throw new Error("The imported canvas exceeds the 128 MB document budget");
    parts.push(value);
    bufferedBytes += bytes;
    if (bufferedBytes >= 128 * 1024) {
      const chunk = parts.join("");
      parts = [];
      bufferedBytes = 0;
      return file.writeFile(chunk);
    }
    return undefined;
  };
  try {
    await write(
      `{"name":${JSON.stringify(result.name)},"rootIds":${JSON.stringify(result.rootIds)},"warnings":${JSON.stringify(result.warnings)},"nodes":{`,
    );
    let comma = "";
    for (const [id, node] of Object.entries(result.nodes)) {
      const json = JSON.stringify(node);
      // Validate the wire value: JSON converts nonfinite numbers to null.
      if (!isNode(JSON.parse(json))) throw new Error(`Invalid imported canvas node: ${id}`);
      const pending = write(`${comma}${JSON.stringify(id)}:${json}`);
      if (pending) await pending;
      comma = ",";
    }
    await write('},"assets":{');
    comma = "";
    for (const [id, asset] of Object.entries(result.assets)) {
      const json = JSON.stringify(asset);
      if (!isAsset(JSON.parse(json))) throw new Error(`Invalid imported canvas asset: ${id}`);
      const pending = write(`${comma}${JSON.stringify(id)}:${json}`);
      if (pending) await pending;
      comma = ",";
    }
    await write("}}");
    if (parts.length > 0) await file.writeFile(parts.join(""));
  } finally {
    await file.close();
  }
}
