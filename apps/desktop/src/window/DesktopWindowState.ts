import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

// Persisted geometry of the main window. `width`/`height` are the un-maximized
// ("normal") content bounds; `maximized` restores the maximized state on top of
// them. `x`/`y` are optional so a document written before we tracked position
// (or one whose position is off-screen on load) still restores the size.
const WindowStateDocument = Schema.Struct({
  x: Schema.optionalKey(Schema.Number),
  y: Schema.optionalKey(Schema.Number),
  width: Schema.Number,
  height: Schema.Number,
  maximized: Schema.optionalKey(Schema.Boolean),
});

export type WindowState = typeof WindowStateDocument.Type;

const WindowStateJson = fromLenientJson(WindowStateDocument);
const decodeWindowStateJson = Schema.decodeEffect(WindowStateJson);
const encodeWindowStateJson = Schema.encodeEffect(WindowStateJson);

export class DesktopWindowStateWriteError extends Schema.TaggedErrorClass<DesktopWindowStateWriteError>()(
  "DesktopWindowStateWriteError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist desktop window state at ${this.path}.`;
  }
}

export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface InitialWindowBounds {
  // Spread straight into BrowserWindow options. `x`/`y` are dropped when the
  // saved position lands outside every display so the window can't open
  // off-screen (e.g. after an external monitor is unplugged).
  readonly bounds: { x?: number; y?: number; width: number; height: number };
  readonly maximize: boolean;
}

const isUsableSize = (state: WindowState): boolean =>
  Number.isFinite(state.width) &&
  state.width > 0 &&
  Number.isFinite(state.height) &&
  state.height > 0;

const rectsIntersect = (a: WindowRect, b: WindowRect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// Pure so it can be unit-tested without Electron. `displays` are the work areas
// of the connected screens; pass `screen.getAllDisplays().map((d) => d.workArea)`.
export function resolveInitialWindowBounds(
  saved: Option.Option<WindowState>,
  displays: readonly WindowRect[],
  defaults: { readonly width: number; readonly height: number },
): InitialWindowBounds {
  if (Option.isNone(saved)) {
    return { bounds: { ...defaults }, maximize: false };
  }

  const state = saved.value;
  const size = { width: state.width, height: state.height };
  const maximize = state.maximized === true;

  if (state.x === undefined || state.y === undefined) {
    return { bounds: size, maximize };
  }

  const rect: WindowRect = { x: state.x, y: state.y, width: state.width, height: state.height };
  const onScreen = displays.some((display) => rectsIntersect(display, rect));
  return onScreen ? { bounds: rect, maximize } : { bounds: size, maximize };
}

export class DesktopWindowState extends Context.Service<
  DesktopWindowState,
  {
    readonly load: Effect.Effect<Option.Option<WindowState>>;
    readonly save: (state: WindowState) => Effect.Effect<void, DesktopWindowStateWriteError>;
  }
>()("@t3tools/desktop/window/DesktopWindowState") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load = fileSystem.readFileString(environment.windowStatePath).pipe(
    Effect.flatMap(decodeWindowStateJson),
    Effect.map((state) => (isUsableSize(state) ? Option.some(state) : Option.none<WindowState>())),
    // Missing file, unreadable file, or a malformed document all fall back to
    // "no saved state" so a first launch (or a corrupt file) opens at defaults.
    Effect.orElseSucceed(() => Option.none<WindowState>()),
    Effect.withSpan("desktop.windowState.load"),
  );

  const save = (state: WindowState) =>
    encodeWindowStateJson(state).pipe(
      Effect.flatMap((encoded) =>
        fileSystem
          .makeDirectory(path.dirname(environment.windowStatePath), { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFileString(environment.windowStatePath, `${encoded}\n`)),
          ),
      ),
      Effect.mapError(
        (cause) => new DesktopWindowStateWriteError({ path: environment.windowStatePath, cause }),
      ),
      Effect.withSpan("desktop.windowState.save"),
    );

  return DesktopWindowState.of({ load, save });
});

export const layer = Layer.effect(DesktopWindowState, make);
