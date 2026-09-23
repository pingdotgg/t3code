declare module "*.wasm" {
  const value: ArrayBuffer;
  export default value;
}

declare module "*.wasm?module" {
  const value: ArrayBuffer;
  export default value;
}

declare module "*.wasm?init" {
  const init: (imports?: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
  export default init;
}

declare module "*.txt" {
  const value: string;
  export default value;
}

declare module "*.html" {
  const value: string;
  export default value;
}

declare module "*.sql" {
  const value: string;
  export default value;
}

declare module "*.bin" {
  const value: ArrayBuffer;
  export default value;
}

declare module "distilled:export-types" {
  export function getExportTypes(module: unknown): Record<string, string>;
}
