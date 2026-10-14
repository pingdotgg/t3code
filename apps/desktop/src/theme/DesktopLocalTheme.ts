// @effect-diagnostics nodeBuiltinImport:off -- Acquire watches before publishing snapshots, including after symlink switches.
import * as NodeFS from "node:fs";
import { EnvironmentThemeFile, type DesktopLocalThemeState } from "@t3tools/contracts";
import { MAX_THEME_FILE_BYTES, readThemeFileGuarded } from "@t3tools/shared/themeFile";
import { THEME_COLOR_ROLES } from "@t3tools/shared/themePalettes";
import "culori/css";
import { converter, parse } from "culori/fn";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export class DesktopLocalTheme extends Context.Service<
  DesktopLocalTheme,
  {
    readonly current: Effect.Effect<DesktopLocalThemeState>;
    readonly setFile: (
      path: string | null,
    ) => Effect.Effect<DesktopLocalThemeState, DesktopAppSettings.DesktopSettingsWriteError>;
  }
>()("@t3tools/desktop/theme/DesktopLocalTheme") {}

const decode = Schema.decodeUnknownExit(Schema.fromJsonString(EnvironmentThemeFile));
const toRgb = converter("rgb");
const knownRoles = new Set<string>(THEME_COLOR_ROLES);

function usableColor(value: string): boolean {
  const parsed = parse(value);
  const rgb = parsed && toRgb(parsed);
  if (!rgb) return false;
  return [rgb.r, rgb.g, rgb.b, rgb.alpha ?? 1].every(Number.isFinite);
}

function usablePalette(theme: EnvironmentThemeFile): boolean {
  if (theme.canvas && theme.accent && usableColor(theme.canvas) && usableColor(theme.accent))
    return true;
  return [theme.colors, theme.variants?.[theme.appearance === "dark" ? "light" : "dark"]].some(
    (colors) =>
      Object.entries(colors ?? {}).some(
        ([role, color]) => knownRoles.has(role) && usableColor(color),
      ),
  );
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const native = yield* ElectronTheme.ElectronTheme;
  const windows = yield* ElectronWindow.ElectronWindow;
  const fs = yield* FileSystem.FileSystem;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const path = environment.path;
  const nativeTheme = yield* native.systemTheme;
  const state = yield* Ref.make<DesktopLocalThemeState>({
    ...nativeTheme,
    source: "native",
    filePath: null,
    status: "ready",
    theme: null,
  });
  const semaphore = yield* Semaphore.make(1);
  const updates = yield* Queue.unbounded<void>();
  const fileUpdates = yield* Queue.unbounded<void>();
  yield* Effect.addFinalizer(() => Queue.shutdown(updates));
  yield* Effect.addFinalizer(() => Queue.shutdown(fileUpdates));
  const omarchyFiles =
    environment.platform === "linux"
      ? [
          path.join(environment.homeDirectory, ".local/state/omarchy/current/theme/t3code.json"),
          path.join(environment.homeDirectory, ".config/omarchy/current/theme/t3code.json"),
        ]
      : [];

  const refresh = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const nativeTheme = yield* native.systemTheme;
      const explicitFile = (yield* settings.get).localThemeFile;
      const previous = yield* Ref.get(state);
      let file = explicitFile;
      if (file === null) {
        for (const candidate of omarchyFiles) {
          if (yield* exists(candidate)) {
            file = candidate;
            break;
          }
        }
        if (file === null && previous.source === "omarchy") file = previous.filePath;
      }
      let next: DesktopLocalThemeState = {
        ...nativeTheme,
        source: "native",
        filePath: null,
        status: "ready",
        theme: null,
      };
      if (file !== null) {
        const source = explicitFile === null ? "omarchy" : "file";
        const raw = readThemeFileGuarded(file, MAX_THEME_FILE_BYTES);
        const decoded = raw === null ? null : decode(raw);
        const theme =
          decoded?._tag === "Success" && usablePalette(decoded.value) ? decoded.value : null;
        const retained =
          previous.source === source && previous.filePath === file ? previous.theme : null;
        const currentTheme = theme ?? retained;
        next = {
          appearance: currentTheme?.appearance ?? nativeTheme.appearance,
          accent: nativeTheme.accent,
          source,
          filePath: file,
          status: theme !== null ? "ready" : (yield* exists(file)) ? "invalid" : "missing",
          theme: currentTheme,
        };
      }
      if (Equal.equals(previous, next)) return;
      yield* Ref.set(state, next);
      yield* windows
        .sendAll(IpcChannels.LOCAL_THEME_CHANNEL, next)
        .pipe(Effect.ignoreCause({ log: true }));
    }),
  );

  let watchers: NodeFS.FSWatcher[] = [];
  const closeWatches = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };
  yield* Effect.addFinalizer(() => Effect.sync(closeWatches));
  const watchSemaphore = yield* Semaphore.make(1);
  const watchDirectories = watchSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const file = (yield* settings.get).localThemeFile;
      const directories = new Set(
        [...omarchyFiles, ...(file === null ? [] : [file])].flatMap((file) => [
          path.dirname(file),
          // Omarchy changes the theme directory symlink, not just its contents.
          path.dirname(path.dirname(file)),
        ]),
      );
      yield* Effect.sync(() => {
        closeWatches();
        for (const directory of directories) {
          try {
            const watcher = NodeFS.watch(directory, { persistent: false }, () => {
              Queue.offerUnsafe(fileUpdates, undefined);
            });
            watcher.on("error", () => watcher.close());
            watchers.push(watcher);
          } catch {
            // The recovery tick retries directories that do not exist yet.
          }
        }
      });
    }),
  );

  yield* watchDirectories;
  yield* native.onUpdated(() => {
    Queue.offerUnsafe(updates, undefined);
  });
  yield* refresh;
  yield* Stream.merge(
    Stream.fromQueue(updates),
    Stream.fromQueue(fileUpdates).pipe(Stream.debounce("100 millis")),
  ).pipe(
    Stream.runForEach(() => watchDirectories.pipe(Effect.andThen(refresh))),
    Effect.forkScoped,
  );
  // Recover unavailable directories and attach new watches after they appear.
  yield* Stream.tick("30 seconds").pipe(
    Stream.runForEach(() => watchDirectories.pipe(Effect.andThen(refresh))),
    Effect.forkScoped,
  );

  return DesktopLocalTheme.of({
    current: Ref.get(state),
    setFile: (file) =>
      Effect.gen(function* () {
        const resolved =
          file === null || file.trim() === ""
            ? null
            : path.resolve(environment.homeDirectory, file.trim());
        yield* settings.setLocalThemeFile(resolved);
        yield* watchDirectories;
        yield* refresh;
        return yield* Ref.get(state);
      }),
  });
});

export const layer = Layer.effect(DesktopLocalTheme, make);
