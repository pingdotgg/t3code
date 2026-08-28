import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Linux ships as an AppImage, so the .desktop entry users end up with is
// created by whatever integration tool they use (AppImageLauncher names it
// appimagekit_<hash>-….desktop) and its filename is not under our control.
// Electron's app.setAsDefaultProtocolClient resolves the desktop id from
// setDesktopName, which cannot match those files — so the browser keeps
// prompting "Choose an application" for every OAuth callback. Instead, write
// our own handler entry pointing at the current AppImage and claim the
// scheme default via xdg-mime, exactly what the file manager's "set as
// default" checkbox would record in mimeapps.list.
export const URL_HANDLER_DESKTOP_ENTRY_NAME = "t3code-url-handler.desktop";

const { logInfo, logWarning } = makeComponentLogger("desktop-linux-url-handler");

export class DesktopLinuxUrlHandlerRegistrationError extends Schema.TaggedErrorClass<DesktopLinuxUrlHandlerRegistrationError>()(
  "DesktopLinuxUrlHandlerRegistrationError",
  {
    step: Schema.Literals(["write-desktop-entry", "set-default-handler"]),
    scheme: Schema.String,
    desktopEntryPath: Schema.optionalKey(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : `, xdg-mime exit code ${this.exitCode}`;
    return `Failed to register the ${this.scheme}:// URL handler (step: ${this.step}${exitCode}).`;
  }
}

const isRegistrationError = Schema.is(DesktopLinuxUrlHandlerRegistrationError);

const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

// Exec values are unescaped twice by implementations: first the general
// string-value rules, then the Exec quoting rules — so writing composes the
// layers in reverse. The argument is double-quoted with reserved characters
// backslash-escaped and literal percent signs doubled (field codes), and the
// general string escaping is applied on top: a literal backslash ends up as
// four backslashes in the file, a quote as \\", a dollar sign as \\$.
export function escapeDesktopEntryExecArgument(value: string): string {
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

// xdg-utils' generic resolver reads the first Exec token without applying the
// desktop-entry quoting rules. Restrict explicit launcher overrides to a small
// portable character set so they can be emitted as one unquoted token.
export function isSafeUnquotedDesktopEntryExecTarget(value: string): boolean {
  return /^\/[A-Za-z0-9._+/-]+$/.test(value);
}

// The AppImage integration entry owns the window identity and icon. This
// hidden URL-only entry must not compete with it for StartupWMClass matching.
export function renderUrlHandlerDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
  readonly unquotedExecTarget?: boolean;
  readonly scheme: string;
}): string {
  const renderedExecTarget =
    input.unquotedExecTarget && isSafeUnquotedDesktopEntryExecTarget(input.execTarget)
      ? input.execTarget
      : escapeDesktopEntryExecArgument(input.execTarget);
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=${renderedExecTarget} %U`,
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    `MimeType=x-scheme-handler/${input.scheme};`,
    "",
  ].join("\n");
}

export class DesktopLinuxUrlHandler extends Context.Service<
  DesktopLinuxUrlHandler,
  {
    readonly register: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLinuxUrlHandler") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
  const desktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    URL_HANDLER_DESKTOP_ENTRY_NAME,
  );

  const defaultExecTarget = {
    path: Option.getOrElse(environment.appImagePath, () => process.execPath),
    unquoted: false,
  } as const;

  const resolveExecTarget = Effect.gen(function* () {
    const override = Option.getOrUndefined(environment.linuxUrlHandlerExecutableOverride);
    if (override === undefined) {
      return defaultExecTarget;
    }

    if (!environment.path.isAbsolute(override)) {
      yield* logWarning("ignoring invalid URL handler executable override", {
        scheme,
        reason: "path-not-absolute",
      });
      return defaultExecTarget;
    }
    if (override.includes("\0")) {
      yield* logWarning("ignoring invalid URL handler executable override", {
        scheme,
        reason: "path-contains-null",
      });
      return defaultExecTarget;
    }

    const normalizedOverride = environment.path.normalize(override);
    if (!isSafeUnquotedDesktopEntryExecTarget(normalizedOverride)) {
      yield* logWarning("ignoring invalid URL handler executable override", {
        scheme,
        reason: "path-not-safe-unquoted",
      });
      return defaultExecTarget;
    }

    const executableInfo = yield* fileSystem.stat(normalizedOverride).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(executableInfo) || executableInfo.value.type !== "File") {
      yield* logWarning("ignoring invalid URL handler executable override", {
        scheme,
        reason: "path-not-file",
      });
      return defaultExecTarget;
    }

    const executableProbe = ChildProcess.make("test", ["-x", normalizedOverride], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const executableProbeExitCode = yield* spawner.exitCode(executableProbe).pipe(
      Effect.map(Number),
      Effect.orElseSucceed(() => 1),
    );
    if (executableProbeExitCode !== 0) {
      yield* logWarning("ignoring invalid URL handler executable override", {
        scheme,
        reason: "path-not-executable",
      });
      return defaultExecTarget;
    }

    return { path: normalizedOverride, unquoted: true } as const;
  });

  const writeDesktopEntry = Effect.gen(function* () {
    // Inside the mounted AppImage, process.execPath points at a transient
    // /tmp/.mount_* path — the handler must launch the AppImage itself.
    // A fleet launcher may opt into a stable executable without changing
    // APPIMAGE, which electron-updater still needs to identify the artifact.
    // Every launch route must carry the override or the next registration will
    // intentionally rewrite this entry back to the APPIMAGE/process fallback.
    const execTarget = yield* resolveExecTarget;
    yield* fileSystem.makeDirectory(environment.linuxApplicationsDir, { recursive: true });
    yield* fileSystem.writeFileString(
      desktopEntryPath,
      renderUrlHandlerDesktopEntry({
        displayName: environment.displayName,
        execTarget: execTarget.path,
        unquotedExecTarget: execTarget.unquoted,
        scheme,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLinuxUrlHandlerRegistrationError({
          step: "write-desktop-entry",
          scheme,
          desktopEntryPath,
          cause,
        }),
    ),
  );

  const setDefaultHandler = Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(
        "xdg-mime",
        ["default", URL_HANDLER_DESKTOP_ENTRY_NAME, `x-scheme-handler/${scheme}`],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const handle = yield* spawner.spawn(command);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) {
        return yield* new DesktopLinuxUrlHandlerRegistrationError({
          step: "set-default-handler",
          scheme,
          exitCode: Number(exitCode),
        });
      }
    }),
  ).pipe(
    Effect.mapError((error) =>
      isRegistrationError(error)
        ? error
        : new DesktopLinuxUrlHandlerRegistrationError({
            step: "set-default-handler",
            scheme,
            cause: error,
          }),
    ),
  );

  const register = Effect.gen(function* () {
    if (environment.platform !== "linux" || !environment.isPackaged) {
      return;
    }
    yield* writeDesktopEntry;
    yield* setDefaultHandler;
    yield* logInfo("registered URL scheme handler", { scheme });
  }).pipe(
    // Registration is best-effort: a missing xdg-mime or read-only home must
    // never block startup — the OS chooser remains as fallback.
    Effect.catch((error) =>
      logWarning("URL scheme handler registration failed", {
        scheme,
        step: error.step,
        message: error.message,
        ...(error.desktopEntryPath === undefined
          ? {}
          : { desktopEntryPath: error.desktopEntryPath }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      }),
    ),
    Effect.withSpan("desktop.linuxUrlHandler.register"),
  );

  return DesktopLinuxUrlHandler.of({ register });
});

export const layer = Layer.effect(DesktopLinuxUrlHandler, make);
