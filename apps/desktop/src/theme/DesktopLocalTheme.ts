import {
  EnvironmentThemeFile,
  type DesktopLocalThemeState,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
import { MAX_THEME_FILE_BYTES, readThemeFileGuarded } from "@t3tools/shared/themeFile";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

export class DesktopLocalTheme extends Context.Service<
  DesktopLocalTheme,
  {
    readonly current: Effect.Effect<DesktopLocalThemeState>;
  }
>()("@t3tools/desktop/theme/DesktopLocalTheme") {}

const decode = Schema.decodeUnknownExit(Schema.fromJsonString(EnvironmentThemeFile));

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const windows = yield* ElectronWindow.ElectronWindow;
  const fs = yield* FileSystem.FileSystem;
  const theme = yield* Ref.make<EnvironmentThemeFile | null>(null);
  if (Option.isNone(environment.localThemeFile)) {
    return DesktopLocalTheme.of({ current: Effect.succeed({ enabled: false, theme: null }) });
  }
  const file = environment.localThemeFile.value;
  const semaphore = yield* Semaphore.make(1);
  const refresh = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const raw = readThemeFileGuarded(file, MAX_THEME_FILE_BYTES);
      if (raw === null) return;
      const decoded = decode(raw);
      if (decoded._tag === "Failure" || !environmentThemeFileHasColors(decoded.value)) return;
      const next = decoded.value;
      if (Equal.equals(yield* Ref.get(theme), next)) return;
      yield* Ref.set(theme, next);
      yield* windows
        .sendAll(IpcChannels.LOCAL_THEME_CHANNEL, { enabled: true, theme: next })
        .pipe(Effect.ignoreCause({ log: true }));
    }),
  );
  yield* refresh;
  // Watch the directory because publishers replace the file atomically. The
  // periodic read also recovers a missing directory, failed watch, or resume.
  const events = fs.watch(environment.path.dirname(file)).pipe(
    Stream.debounce("100 millis"),
    Stream.map(() => undefined),
    Stream.catchCause(() => Stream.empty),
  );
  yield* Stream.merge(events, Stream.tick("30 seconds")).pipe(
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );
  return DesktopLocalTheme.of({
    current: refresh.pipe(
      Effect.andThen(Ref.get(theme)),
      Effect.map((theme) => ({ enabled: true, theme })),
    ),
  });
});

export const layer = Layer.effect(DesktopLocalTheme, make);
