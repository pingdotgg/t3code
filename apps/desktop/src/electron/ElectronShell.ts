import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export class ElectronShellOpenExternalError extends Schema.TaggedErrorClass<ElectronShellOpenExternalError>()(
  "ElectronShellOpenExternalError",
  {
    urlHostname: Schema.String,
    urlLength: Schema.Number,
    urlProtocol: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to open external URL for ${this.urlHostname} (${this.urlProtocol}, input length ${this.urlLength}).`;
  }
}

export class ElectronShellCopyTextError extends Schema.TaggedErrorClass<ElectronShellCopyTextError>()(
  "ElectronShellCopyTextError",
  {
    textLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.textLength} characters to the clipboard.`;
  }
}

export const ElectronShellError = Schema.Union([
  ElectronShellOpenExternalError,
  ElectronShellCopyTextError,
]);
export type ElectronShellError = typeof ElectronShellError.Type;
export const isElectronShellError = Schema.is(ElectronShellError);

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

function describeExternalUrl(externalUrl: string, inputLength: number) {
  const diagnostics = getUrlDiagnostics(externalUrl);
  return {
    urlHostname: diagnostics.hostname ?? "",
    urlLength: inputLength,
    urlProtocol: diagnostics.protocol ?? "",
  };
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (
      rawUrl: unknown,
    ) => Effect.Effect<boolean, ElectronShellOpenExternalError>;
    readonly copyText: (text: string) => Effect.Effect<void, ElectronShellCopyTextError>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) => {
    const inputLength = typeof rawUrl === "string" ? rawUrl.length : 0;

    return Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.tryPromise({
          try: () => Electron.shell.openExternal(externalUrl),
          catch: (cause) =>
            new ElectronShellOpenExternalError({
              ...describeExternalUrl(externalUrl, inputLength),
              cause,
            }),
        }).pipe(Effect.as(true)),
    });
  },
  copyText: (text) =>
    Effect.try({
      try: () => Electron.clipboard.writeText(text),
      catch: (cause) => new ElectronShellCopyTextError({ textLength: text.length, cause }),
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
