import type * as Path from "effect/Path";

/** Home's own workspace: its instructions and notes. No other thread may start in it. */
export const homeFolderRoot = (baseDir: string, path: Path.Path) => path.resolve(baseDir, "home");
