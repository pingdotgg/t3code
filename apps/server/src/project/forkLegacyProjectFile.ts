/**
 * Fork-only. Lathe's project file is lathe.json; before the rename it was
 * t3.json. A project that still has only a t3.json keeps working: readers
 * take lathe.json first and fall back to t3.json, warning so the file can be
 * renamed. Nothing writes t3.json.
 */
import { LATHE_PROJECT_FILE_NAME } from "@lathe/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const LEGACY_PROJECT_FILE_NAME = "t3.json";

/** The names a project file may have in a commit, the one to read first. */
export const PROJECT_FILE_NAMES = [LATHE_PROJECT_FILE_NAME, LEGACY_PROJECT_FILE_NAME] as const;

/** The project file to read in `workspaceRoot`: lathe.json, else an existing t3.json. */
export const projectFilePath = Effect.fn("projectFilePath")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  workspaceRoot: string,
) {
  const latheFile = path.join(workspaceRoot, LATHE_PROJECT_FILE_NAME);
  const legacyFile = path.join(workspaceRoot, LEGACY_PROJECT_FILE_NAME);
  const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
  if ((yield* exists(latheFile)) || !(yield* exists(legacyFile))) return latheFile;
  yield* Effect.logWarning(
    `${LEGACY_PROJECT_FILE_NAME} is the project file's pre-rename name; rename it to ${LATHE_PROJECT_FILE_NAME}`,
    { workspaceRoot },
  );
  return legacyFile;
});

/** A client read of lathe.json that fails is answered from t3.json, under the name it asked for. */
export const readProjectFileWithLegacyFallback = <
  Input extends { readonly relativePath: string },
  Result extends { readonly relativePath: string },
  E,
  R,
>(
  input: Input,
  read: (input: Input) => Effect.Effect<Result, E, R>,
): Effect.Effect<Result, E, R> =>
  input.relativePath !== LATHE_PROJECT_FILE_NAME
    ? read(input)
    : read(input).pipe(
        Effect.catch((error) =>
          read({ ...input, relativePath: LEGACY_PROJECT_FILE_NAME }).pipe(
            Effect.map((result) => ({ ...result, relativePath: input.relativePath })),
            Effect.mapError(() => error),
          ),
        ),
      );
