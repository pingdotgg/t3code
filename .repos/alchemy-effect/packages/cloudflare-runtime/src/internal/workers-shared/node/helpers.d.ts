// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
/** normalises sep for windows and prefix with `/` */
export declare const normalizeFilePath: (relativeFilepath: string) => string;
export declare const getContentType: (absFilePath: string) => string | null;
/**
 * Generate a function that can match relative filepaths against a list of gitignore formatted patterns.
 */
export declare function createPatternMatcher(
  patterns: Array<string>,
  exclude: boolean,
): (filePath: string) => boolean;
/**
 * Create a function for filtering out ignored assets.
 *
 * The generated function takes an asset path, relative to the asset directory,
 * and returns true if the asset should not be ignored.
 */
export declare const createAssetsIgnoreFunction: (dir: string) => Effect.Effect<
  {
    assetsIgnoreFunction: (filePath: string) => boolean;
    assetsIgnoreFilePresent: boolean;
  },
  PlatformError,
  FileSystem.FileSystem | Path.Path
>;
//# sourceMappingURL=helpers.d.ts.map
