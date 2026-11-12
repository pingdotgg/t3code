/** Foldkit builds and native development, with platform-specific deployment targets. */
export * from "./Foldkit.ts";
import { layer, type FoldkitOptions } from "./Foldkit.ts";
export default (options?: { readonly foldkit?: FoldkitOptions }) => layer(options?.foldkit);
