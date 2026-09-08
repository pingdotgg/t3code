import path from "node:path";
import type { OutputAsset, OutputChunk } from "rolldown";

export interface MiniflareModule {
  path: string;
  type:
    | "ESModule"
    | "CommonJS"
    | "Text"
    | "Data"
    | "CompiledWasm"
    | "PythonModule"
    | "PythonRequirement";
  contents?: string | Uint8Array<ArrayBuffer> | undefined;
}

export function miniflareModulesFromRolldownOutput(
  output: Array<OutputChunk | OutputAsset>,
): Array<MiniflareModule> {
  return output.flatMap((item) => {
    const type = moduleTypeFromExtension(path.extname(item.fileName));
    const contents =
      item.type === "chunk"
        ? item.code
        : (item.source as string | Uint8Array<ArrayBuffer>);
    if (type === "SourceMap") {
      return [];
    }
    return {
      path: item.fileName,
      type,
      contents,
    };
  });
}

export function moduleTypeFromExtension(
  ext: string,
): MiniflareModule["type"] | "SourceMap" {
  switch (ext) {
    case ".wasm":
      return "CompiledWasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".css":
    case ".json":
    case ".custom":
      return "Text";
    case ".bin":
      return "Data";
    case ".mjs":
    case ".js":
      return "ESModule";
    case ".cjs":
      return "CommonJS";
    case ".map":
      return "SourceMap";
    default:
      return "Text";
  }
}
