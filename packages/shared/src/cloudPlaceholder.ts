// @effect-diagnostics nodeBuiltinImport:off -- Keep the optional macOS probe usable by filesystem-only discovery.
import * as NodeChildProcess from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export const DarwinFileFlags = Context.Reference<(path: string) => Effect.Effect<number | null>>(
  "@t3tools/shared/cloudPlaceholder/DarwinFileFlags",
  {
    defaultValue: () => (path) =>
      Effect.callback<number | null>((resume) => {
        try {
          const child = NodeChildProcess.execFile(
            "/usr/bin/stat",
            ["-L", "-f", "%Uf", "--", path],
            { encoding: "utf8", timeout: 1000 },
            (error, stdout) => {
              const value = stdout.trim();
              resume(Effect.succeed(!error && /^\d+$/.test(value) ? Number(value) : null));
            },
          );
          return Effect.sync(() => child.kill());
        } catch {
          resume(Effect.succeed(null));
        }
      }),
  },
);

export const isCloudPlaceholder = Effect.fn("isCloudPlaceholder")(function* (
  info: FileSystem.File.Info,
  platform: NodeJS.Platform,
  path: string,
) {
  if (
    platform !== "darwin" ||
    info.type !== "File" ||
    info.size === 0n ||
    Option.getOrUndefined(info.blocks) !== 0n
  ) {
    return false;
  }
  // Inline APFS compression also reports zero blocks; only SF_DATALESS means online-only.
  const readFlags = yield* DarwinFileFlags;
  const flags = yield* readFlags(path);
  // If metadata cannot be checked, avoid a read that could exhaust the libuv pool.
  return flags === null || (flags & 0x40000000) !== 0;
});
