import { THEME_FILE_MAX_BYTES, type PickedThemeFile } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

const OMARCHY_THEME_RELATIVE_PATH = [
  ".local",
  "state",
  "omarchy",
  "current",
  "theme",
  "vscode-theme.json",
] as const;

export interface OmarchyThemePaths {
  readonly currentDirectory: string;
  readonly themeDirectory: string;
  readonly themeFile: string;
}

export function resolveOmarchyThemePaths(
  homeDirectory: string,
  path: Path.Path,
): OmarchyThemePaths {
  const themeFile = path.join(homeDirectory, ...OMARCHY_THEME_RELATIVE_PATH);
  const themeDirectory = path.dirname(themeFile);
  return {
    currentDirectory: path.dirname(themeDirectory),
    themeDirectory,
    themeFile,
  };
}

const readThemeFile = Effect.fn("desktop.omarchyTheme.readFile")(function* (
  fileSystem: FileSystem.FileSystem,
  themeFile: string,
) {
  if (!(yield* fileSystem.exists(themeFile).pipe(Effect.orElseSucceed(() => false)))) return null;
  return yield* Effect.gen(function* () {
    const info = yield* fileSystem.stat(themeFile);
    if (info.type !== "File") return null;
    const size = Number(info.size);
    if (size > THEME_FILE_MAX_BYTES) {
      return { name: "vscode-theme.json", size, text: "" };
    }
    return {
      name: "vscode-theme.json",
      size,
      text: yield* fileSystem.readFileString(themeFile),
    };
  }).pipe(
    // A present but unreadable file must not erase the renderer's last valid palette.
    Effect.orElseSucceed(
      (): PickedThemeFile => ({
        name: "vscode-theme.json",
        size: 0,
        text: "",
      }),
    ),
  );
});

const DEFAULT_MISSING_RETRIES = 3;
const DEFAULT_MISSING_RETRY_DELAY = Duration.millis(50);

const confirmMissingThemeFile = Effect.fn("desktop.omarchyTheme.confirmMissing")(function* (
  readTheme: Effect.Effect<PickedThemeFile | null>,
  options?: {
    readonly retries?: number;
    readonly retryDelay?: Duration.Input;
  },
) {
  const retries = options?.retries ?? DEFAULT_MISSING_RETRIES;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const theme = yield* readTheme;
    if (theme !== null || attempt === retries) return theme;
    yield* Effect.sleep(options?.retryDelay ?? DEFAULT_MISSING_RETRY_DELAY);
  }
  return null;
});

export function makeOmarchyThemeChangeStream<E, R>(
  events: Stream.Stream<unknown, E, R>,
  readTheme: Effect.Effect<PickedThemeFile | null>,
  options?: {
    readonly debounce?: Duration.Input;
    readonly missingRetries?: number;
    readonly missingRetryDelay?: Duration.Input;
  },
): Stream.Stream<PickedThemeFile | null, E, R> {
  return events.pipe(
    Stream.debounce(options?.debounce ?? Duration.millis(50)),
    Stream.mapEffect(() =>
      confirmMissingThemeFile(readTheme, {
        ...(options?.missingRetries === undefined ? {} : { retries: options.missingRetries }),
        ...(options?.missingRetryDelay === undefined
          ? {}
          : { retryDelay: options.missingRetryDelay }),
      }),
    ),
    Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
  );
}

export const readOmarchyThemeFile = Effect.fn("desktop.omarchyTheme.read")(function* (input: {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
}) {
  if (input.platform !== "linux") return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* readThemeFile(
    fileSystem,
    resolveOmarchyThemePaths(input.homeDirectory, path).themeFile,
  );
});

/**
 * Omarchy replaces `current/theme` via remove-then-move, which invalidates a
 * watcher on that directory. Watching its stable parent observes every theme
 * swap and needs only one bounded watcher for the lifetime of the desktop app.
 */
export const watchOmarchyTheme = Effect.fn("desktop.omarchyTheme.watch")(function* (
  input: {
    readonly homeDirectory: string;
    readonly platform: NodeJS.Platform;
  },
  onChange: (theme: PickedThemeFile | null) => Effect.Effect<void>,
) {
  if (input.platform !== "linux") return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = resolveOmarchyThemePaths(input.homeDirectory, path);
  if (!(yield* fileSystem.exists(paths.currentDirectory).pipe(Effect.orElseSucceed(() => false)))) {
    return;
  }

  yield* makeOmarchyThemeChangeStream(
    fileSystem.watch(paths.currentDirectory),
    readThemeFile(fileSystem, paths.themeFile),
  ).pipe(Stream.runForEach(onChange));
});
