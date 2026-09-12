import type { TransformOptions } from "rolldown/utils";

export interface TransformContext {
  readonly url: string;
  readonly path: string;
  readonly format: "module" | "commonjs";
}

export interface SourceTransformResult {
  readonly code: string;
  readonly map?: string | object | undefined;
}

export type SourceTransform = (
  code: string,
  context: TransformContext,
) => string | SourceTransformResult | undefined;

export interface ImportLoaderOptions {
  /**
   * Additional package export conditions used during module resolution.
   * They are made available alongside Node's ambient conditions to both the
   * TypeScript-aware resolver and Node's package exports resolver.
   */
  readonly conditions?: ReadonlyArray<string> | undefined;
  /**
   * Oxc transform configuration, layered over the nearest `tsconfig.json`
   * of each transformed file (`jsx`, decorators, …).
   */
  readonly transform?: TransformOptions | undefined;
  /** Additional synchronous source transforms, applied after Oxc. */
  readonly transforms?: ReadonlyArray<SourceTransform> | undefined;
  /**
   * Honour `tsconfig.json` discovered upward from each file: compiler
   * options for the transform, `paths`/`baseUrl` aliases for resolution.
   * @default true
   */
  readonly tsconfig?: boolean | undefined;
  /** Controls which file URLs belong to the fresh import graph. */
  readonly shouldInvalidate?:
    | ((url: string, parentURL: string | undefined) => boolean)
    | undefined;
  /**
   * Limits transformation to matching absolute file paths; everything else
   * loads through Node untouched. Lets a published install transpile only
   * the user's own TypeScript while alchemy and its dependencies run their
   * built JavaScript.
   */
  readonly filter?: ((path: string) => boolean) | undefined;
}

export interface ImportLoaderRegistrationOptions extends ImportLoaderOptions {
  /** Isolates one import graph in the runtime's module cache. */
  readonly namespace?: string | undefined;
  /** Called once the runtime loads a file in this registration's graph. */
  readonly onImport?: ((url: string) => void) | undefined;
}

export interface ImportLoader {
  import<T = unknown>(specifier: string, parentURL: string): Promise<T>;
  unregister(): void | Promise<void>;
}

/** Creates a Node import loader using synchronous module hooks backed by Oxc. */
export const createImportLoader = async (
  options: ImportLoaderRegistrationOptions = {},
): Promise<ImportLoader> => {
  if (process.versions.bun !== undefined) {
    throw new Error(
      "The import-aware loader is only available in Node; use Bun's process-level watcher instead.",
    );
  }
  const { registerOxc } = await import("./register-oxc.ts");
  return registerOxc(options);
};
