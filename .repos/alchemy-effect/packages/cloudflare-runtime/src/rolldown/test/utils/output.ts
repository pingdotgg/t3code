import type { OutputAsset, OutputChunk, RolldownOutput } from "rolldown";

const CLOUDFLARE_MODULE_REFERENCE_REGEX =
  /__CLOUDFLARE_MODULE__(CompiledWasm|Data|Text)__(.*?)__CLOUDFLARE_MODULE__/;

export function getEntryChunk(output: RolldownOutput): OutputChunk {
  const entry = output.output.find(
    (item): item is OutputChunk => item.type === "chunk" && item.isEntry,
  );
  if (!entry) {
    throw new Error("Expected generated output to contain an entry chunk");
  }
  return entry;
}

export function getChunk(output: RolldownOutput, fileName: string): OutputChunk {
  const chunk = output.output.find(
    (item): item is OutputChunk => item.type === "chunk" && item.fileName === fileName,
  );
  if (!chunk) {
    throw new Error(`Expected generated output to contain chunk "${fileName}"`);
  }
  return chunk;
}

export function findAsset(output: RolldownOutput, matcher: RegExp): OutputAsset | undefined {
  return output.output.find(
    (item): item is OutputAsset => item.type === "asset" && matcher.test(item.fileName),
  );
}

export function getAsset(output: RolldownOutput, matcher: RegExp): OutputAsset {
  const asset = findAsset(output, matcher);
  if (!asset) {
    throw new Error(`Expected generated output to contain asset matching ${matcher}`);
  }
  return asset;
}

export function getFileNames(output: RolldownOutput): Array<string> {
  return output.output.map((item) => item.fileName);
}

export function hasCloudflareModuleReferences(code: string): boolean {
  return CLOUDFLARE_MODULE_REFERENCE_REGEX.test(code);
}
