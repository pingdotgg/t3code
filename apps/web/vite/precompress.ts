// @effect-diagnostics nodeBuiltinImport:off - Vite build hooks run outside an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

import type { Plugin } from "vite-plus";

const brotli = NodeUtil.promisify(NodeZlib.brotliCompress);
const gzip = NodeUtil.promisify(NodeZlib.gzip);

// Same types and floor as the server's on-the-fly compression.
const COMPRESSIBLE_FILE = /\.(?:js|mjs|css|json|svg|wasm|txt|xml)$/;
const MIN_BYTES = 1024;

/**
 * Writes `.br` (quality 11) and `.gz` (level 9) next to each hashed asset so
 * the server sends finished bytes instead of compressing on every cold load.
 * Only `assets/` gets copies: those names are content hashed, so a copy can
 * never describe a different version of its file.
 */
export function precompressPlugin(): Plugin {
  return {
    name: "t3code:precompress",
    apply: "build",
    async writeBundle(options, bundle) {
      const outDir = options.dir;
      if (!outDir) return;
      const files = Object.keys(bundle).filter(
        (fileName) => fileName.startsWith("assets/") && COMPRESSIBLE_FILE.test(fileName),
      );
      await Promise.all(
        files.map(async (fileName) => {
          const filePath = NodePath.join(outDir, fileName);
          const source = await NodeFSP.readFile(filePath);
          if (source.byteLength < MIN_BYTES) return;
          const [br, gz] = await Promise.all([
            brotli(source, {
              params: {
                [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 11,
                [NodeZlib.constants.BROTLI_PARAM_MODE]: fileName.endsWith(".wasm")
                  ? NodeZlib.constants.BROTLI_MODE_GENERIC
                  : NodeZlib.constants.BROTLI_MODE_TEXT,
                [NodeZlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
              },
            }),
            gzip(source, { level: 9 }),
          ]);
          await Promise.all([
            br.byteLength < source.byteLength
              ? NodeFSP.writeFile(`${filePath}.br`, br)
              : Promise.resolve(),
            gz.byteLength < source.byteLength
              ? NodeFSP.writeFile(`${filePath}.gz`, gz)
              : Promise.resolve(),
          ]);
        }),
      );
    },
  };
}
