import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ExtraFile } from "../Util/extraFiles.ts";

const nextConfigFiles = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
] as const;

const exists = (target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  });

/**
 * Extra files baked into a container/unit next to the Node serve entry.
 *
 * - `"client"`: the build's dist directory at the image/unit root.
 * - `"next"`: `.next`, `public/`, and `next.config.*` from `from` (the
 *   Next.js app root — for the node target that is also `distDirectory`).
 */
export const packSiteExtraFiles = (
  from: string,
  mode: "client" | "next",
): Effect.Effect<
  ExtraFile[] | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    if (mode === "client") {
      return [{ source: from, dest: "." }];
    }
    const path = yield* Path.Path;
    const nextDir = path.join(from, ".next");
    const publicDir = path.join(from, "public");
    const configPaths = nextConfigFiles.map((name) => ({
      name,
      target: path.join(from, name),
    }));
    const [hasNext, hasPublic, ...configHits] = yield* Effect.all(
      [
        exists(nextDir),
        exists(publicDir),
        ...configPaths.map((file) => exists(file.target)),
      ],
      { concurrency: "unbounded" },
    );
    const files: ExtraFile[] = [];
    if (hasNext) files.push({ source: nextDir, dest: ".next" });
    if (hasPublic) files.push({ source: publicDir, dest: "public" });
    configPaths.forEach((file, i) => {
      if (configHits[i] === true) {
        files.push({ source: file.target, dest: file.name });
      }
    });
    return files.length > 0 ? files : undefined;
  });
