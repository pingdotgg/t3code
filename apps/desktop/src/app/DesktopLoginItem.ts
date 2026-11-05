import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { escapeDesktopEntryExecArgument } from "./DesktopLinuxUrlHandler.ts";

export const LOGIN_ITEM_ARGUMENT = "--t3-login-startup";

export class DesktopLoginItemError extends Schema.TaggedError<DesktopLoginItemError>()(
  "DesktopLoginItemError",
  { reason: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

const isLoginItemError = Schema.is(DesktopLoginItemError);

export class DesktopLoginItem extends Context.Service<
  DesktopLoginItem,
  {
    readonly supported: boolean;
    readonly getEnabled: Effect.Effect<boolean, DesktopLoginItemError>;
    readonly configure: (enabled: boolean) => Effect.Effect<void, DesktopLoginItemError>;
    readonly wasOpenedAtLogin: Effect.Effect<boolean, DesktopLoginItemError>;
  }
>()("@t3tools/desktop/app/DesktopLoginItem") {}

function desktopEntryEnabled(content: string): boolean {
  let inDesktopEntry = false;
  const fields = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator !== -1)
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return (
    fields.get("Type") === "Application" &&
    !!fields.get("Exec") &&
    fields.get("Hidden") !== "true" &&
    fields.get("X-GNOME-Autostart-enabled") !== "false"
  );
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const executablePath = yield* HostProcess.ExecutablePath;
  const args = yield* HostProcess.Arguments;
  const mutex = yield* Semaphore.make(1);
  const supported =
    environment.isPackaged &&
    !environment.isDevelopment &&
    ["win32", "darwin", "linux"].includes(environment.platform);
  const identity = `${environment.appUserModelId}.${environment.branding.stageLabel.toLowerCase()}`;
  const autostartDirectory = environment.path.join(environment.appDataDirectory, "autostart");
  const desktopEntryPath = environment.path.join(autostartDirectory, `${identity}.desktop`);
  const loginArgs = [LOGIN_ITEM_ARGUMENT];
  const nativeOptions =
    environment.platform === "win32"
      ? { path: executablePath, args: loginArgs }
      : { type: "mainAppService" as const };
  const readNative = Effect.try({
    try: () => Electron.app.getLoginItemSettings(nativeOptions),
    catch: (cause) =>
      new DesktopLoginItemError({
        reason: "Could not read the operating system's login settings.",
        cause,
      }),
  });

  const getEnabled = Effect.gen(function* () {
    if (!supported) return false;
    if (environment.platform === "linux") {
      return yield* fileSystem.readFileString(desktopEntryPath).pipe(
        Effect.map(desktopEntryEnabled),
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(false)
              : Effect.fail(
                  new DesktopLoginItemError({
                    reason: "Could not read the desktop autostart entry.",
                    cause,
                  }),
                ),
        }),
      );
    }
    const settings = yield* readNative;
    if (environment.platform === "darwin")
      return settings.openAtLogin && settings.status === "enabled";
    // Electron filters launchItems by executable path; openAtLogin ignores custom names and args omit switches.
    return settings.launchItems.some(
      (item) => item.name === identity && item.scope === "user" && item.enabled,
    );
  }).pipe(Effect.withSpan("desktop.loginItem.getEnabled"));

  const configureLinux = Effect.fn("desktop.loginItem.configureLinux")(
    function* (enabled: boolean) {
      if (
        !/^[a-z0-9][a-z0-9._-]*$/i.test(identity) ||
        !environment.path.isAbsolute(autostartDirectory)
      ) {
        return yield* new DesktopLoginItemError({
          reason: "The desktop autostart location or application identity is invalid.",
        });
      }
      if (!enabled) {
        yield* fileSystem.remove(desktopEntryPath, { force: true });
        return;
      }
      const target = Option.getOrElse(
        Option.orElse(environment.desktopLauncherPath, () => environment.appImagePath),
        () => executablePath,
      );
      if (!environment.path.isAbsolute(target) || /[=\0]/.test(target)) {
        return yield* new DesktopLoginItemError({
          reason: "The application needs a stable absolute executable path for autostart.",
        });
      }
      const content = [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${environment.displayName.replace(/[\r\n\t]/g, " ").replaceAll("\\", "\\\\")}`,
        `Exec=${escapeDesktopEntryExecArgument(target)} ${LOGIN_ITEM_ARGUMENT}`,
        "Terminal=false",
        "StartupNotify=false",
        "\n",
      ].join("\n");
      yield* fileSystem.makeDirectory(autostartDirectory, { recursive: true });
      const temporary = yield* fileSystem.makeTempFile({
        directory: autostartDirectory,
        prefix: ".t3-login-",
      });
      yield* Effect.gen(function* () {
        yield* fileSystem.writeFileString(temporary, content);
        yield* fileSystem.rename(temporary, desktopEntryPath);
      }).pipe(Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)));
    },
    Effect.mapError((cause) =>
      isLoginItemError(cause)
        ? cause
        : new DesktopLoginItemError({
            reason: "Could not update the desktop autostart entry.",
            cause,
          }),
    ),
  );

  return DesktopLoginItem.of({
    supported,
    getEnabled,
    wasOpenedAtLogin: Effect.gen(function* () {
      if (!supported) return false;
      return environment.platform === "darwin"
        ? (yield* readNative).wasOpenedAtLogin
        : args.includes(LOGIN_ITEM_ARGUMENT);
    }).pipe(Effect.withSpan("desktop.loginItem.wasOpenedAtLogin")),
    configure: Effect.fn("desktop.loginItem.configure")(function* (enabled) {
      if (!supported) {
        if (enabled)
          return yield* new DesktopLoginItemError({
            reason: "Launch at login is available in the installed desktop application.",
          });
        return;
      }
      if (environment.platform === "linux") {
        yield* configureLinux(enabled);
        return;
      }
      yield* Effect.try({
        try: () =>
          Electron.app.setLoginItemSettings({
            ...nativeOptions,
            openAtLogin: enabled,
            ...(environment.platform === "win32" ? { enabled, name: identity } : {}),
          }),
        catch: (cause) =>
          new DesktopLoginItemError({
            reason: "Could not update the operating system's login settings.",
            cause,
          }),
      });
      if ((yield* getEnabled) !== enabled) {
        return yield* new DesktopLoginItemError({
          reason:
            "The operating system did not apply the login setting. Check the application's entry in your system's login or startup settings.",
        });
      }
    }, mutex.withPermits(1)),
  });
});

export const layer = Layer.effect(DesktopLoginItem, make);
