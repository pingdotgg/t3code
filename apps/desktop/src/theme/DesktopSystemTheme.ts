import type {
  DesktopSystemTheme as DesktopSystemThemeValue,
  DesktopSystemThemePalette,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

const FLAT_TOML_LINE = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*"([^"\\\r\n]*)"\s*(?:#.*)?$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/;
const WATCH_DEBOUNCE = Duration.millis(100);
const TRANSIENT_REREAD = Duration.millis(50);
const TRANSIENT_REREAD_COUNT = 2;

export interface DesktopSystemThemePaths {
  readonly currentDirectory: string;
  readonly colorsFile: string;
  readonly lightModeMarker: string;
}

export function desktopSystemThemePaths(homeDirectory: string): DesktopSystemThemePaths {
  const currentDirectory = `${homeDirectory.replace(/\/+$/u, "")}/.local/state/omarchy/current`;
  const themeDirectory = `${currentDirectory}/theme`;
  return {
    currentDirectory,
    colorsFile: `${themeDirectory}/colors.toml`,
    lightModeMarker: `${themeDirectory}/light.mode`,
  };
}

export function parseFlatColorsToml(input: string): Readonly<Record<string, string>> | null {
  const values: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = FLAT_TOML_LINE.exec(line);
    if (!match?.[1] || match[2] === undefined || Object.hasOwn(values, match[1])) return null;
    values[match[1]] = match[2];
  }
  return Object.keys(values).length > 0 ? values : null;
}

function canonicalHex(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && HEX_COLOR.test(normalized) ? normalized : null;
}

export function normalizeSystemThemePalette(
  values: Readonly<Record<string, string>>,
): DesktopSystemThemePalette | null {
  const background = canonicalHex(values.background ?? values.bg ?? values.color0);
  const foreground = canonicalHex(values.foreground ?? values.fg ?? values.color7);
  const accent = canonicalHex(values.accent ?? values.blue ?? values.color4);
  const selection = canonicalHex(values.selection ?? values.selection_background ?? values.color8);
  const red = canonicalHex(values.red ?? values.color1);
  const green = canonicalHex(values.green ?? values.color2);
  const yellow = canonicalHex(values.yellow ?? values.color3);
  const blue = canonicalHex(values.blue ?? values.color4);
  const magenta = canonicalHex(values.magenta ?? values.purple ?? values.color5);
  const cyan = canonicalHex(values.cyan ?? values.color6);
  if (
    !background ||
    !foreground ||
    !accent ||
    !selection ||
    !red ||
    !green ||
    !yellow ||
    !blue ||
    !magenta ||
    !cyan
  ) {
    return null;
  }
  return { background, foreground, accent, selection, red, green, yellow, blue, magenta, cyan };
}

function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export const readDesktopSystemTheme = Effect.fn("desktop.systemTheme.read")(function* (input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
}) {
  if (input.platform !== "linux") return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = desktopSystemThemePaths(input.homeDirectory);
  return yield* Effect.gen(function* () {
    const values = parseFlatColorsToml(yield* fileSystem.readFileString(paths.colorsFile));
    if (values === null) return null;
    const colors = normalizeSystemThemePalette(values);
    if (colors === null) return null;
    const declaredMode = (values.mode ?? values.theme_type)?.trim().toLowerCase();
    const appearance: DesktopSystemThemeValue["appearance"] =
      declaredMode === "light" || declaredMode === "dark"
        ? declaredMode
        : (yield* fileSystem.exists(paths.lightModeMarker)) ||
            relativeLuminance(colors.background) >= 0.179
          ? "light"
          : "dark";
    return { appearance, colors };
  }).pipe(Effect.orElseSucceed(() => null));
});

function themesEqual(
  left: DesktopSystemThemeValue | null,
  right: DesktopSystemThemeValue | null,
): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export class DesktopSystemTheme extends Context.Service<
  DesktopSystemTheme,
  { readonly current: Effect.Effect<DesktopSystemThemeValue | null> }
>()("@t3tools/desktop/theme/DesktopSystemTheme") {}

export const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const input = { platform, homeDirectory: NodeOS.homedir() } as const;
  const paths = desktopSystemThemePaths(input.homeDirectory);
  const current = yield* Ref.make(yield* readDesktopSystemTheme(input));

  const refresh = Effect.gen(function* () {
    let next = yield* readDesktopSystemTheme(input);
    const previous = yield* Ref.get(current);
    if (next === null && previous !== null) {
      for (let attempt = 0; attempt < TRANSIENT_REREAD_COUNT && next === null; attempt++) {
        yield* Effect.sleep(TRANSIENT_REREAD);
        next = yield* readDesktopSystemTheme(input);
      }
    }
    if (themesEqual(previous, next)) return;
    yield* Ref.set(current, next);
    yield* electronWindow.sendAll(IpcChannels.SYSTEM_THEME_CHANGED_CHANNEL, next);
  });

  if (input.platform === "linux" && (yield* fileSystem.exists(paths.currentDirectory))) {
    yield* fileSystem.watch(paths.currentDirectory).pipe(
      Stream.debounce(WATCH_DEBOUNCE),
      Stream.runForEach(() => refresh.pipe(Effect.ignoreCause({ log: true }))),
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
    yield* refresh;
  }

  return DesktopSystemTheme.of({ current: Ref.get(current) });
});

export const layer = Layer.effect(DesktopSystemTheme, make);
