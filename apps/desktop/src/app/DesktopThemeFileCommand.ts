import type { PickedThemeFile } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

export const THEME_FILE_ARGUMENT = "--theme-file";
export const THEME_FILE_MAX_BYTES = 256 * 1024;

export function themeFilePathFromArguments(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === THEME_FILE_ARGUMENT) {
      const value = args[index + 1];
      return value && !value.startsWith("--") ? value : null;
    }
    if (argument.startsWith(`${THEME_FILE_ARGUMENT}=`)) {
      const value = argument.slice(THEME_FILE_ARGUMENT.length + 1);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export const readThemeFile = Effect.fn("desktop.themeFileCommand.read")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fileSystem.stat(filePath);
  const size = Number(info.size);
  const text = size > THEME_FILE_MAX_BYTES ? "" : yield* fileSystem.readFileString(filePath);
  return { name: path.basename(filePath), size, text } satisfies PickedThemeFile;
});
