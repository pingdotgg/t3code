import { createPlugin } from "../factory.ts";
import { sanitizePath, toPosixPath } from "../utils.ts";

const WASM_INIT_QUERY = /\.wasm\?init$/;

export const wasmInitPlugin = createPlugin("wasm-init", () => ({
  vite: {
    enforce: "pre",
  },
  shared: {
    load: {
      filter: { id: WASM_INIT_QUERY },
      handler(id) {
        return [
          `import wasmModule from "${toPosixPath(sanitizePath(id))}";`,
          `export default async (imports) => {`,
          `  const result = await WebAssembly.instantiate(wasmModule, imports);`,
          `  return "instance" in result ? result.instance : result;`,
          `};`,
        ].join("\n");
      },
    },
  },
}));
