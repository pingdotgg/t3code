import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export class ElectronShellOpenPathError extends Schema.TaggedErrorClass<ElectronShellOpenPathError>()(
  "ElectronShellOpenPathError",
  {
    path: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to open ${JSON.stringify(this.path)} in its default application: ${this.reason}`;
  }
}

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly openPath: (path: string) => Effect.Effect<void, ElectronShellOpenPathError>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  openPath: Effect.fn("desktop.electron.shell.openPath")(function* (path) {
    const result = yield* Effect.tryPromise({
      try: () => Electron.shell.openPath(path),
      catch: (cause) =>
        new ElectronShellOpenPathError({
          path,
          reason: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    if (result !== "") {
      return yield* new ElectronShellOpenPathError({
        path,
        reason: result,
        cause: new Error(result),
      });
    }
  }),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
