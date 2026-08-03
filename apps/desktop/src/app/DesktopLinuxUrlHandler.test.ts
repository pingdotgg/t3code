import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";

interface RecordedRegistration {
  readonly directories: string[];
  readonly files: Array<{ readonly path: string; readonly content: string }>;
  readonly commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
}

const makeEnvironment = (overrides: Record<string, unknown> = {}) =>
  DesktopEnvironment.DesktopEnvironment.of({
    platform: "linux",
    isPackaged: true,
    isDevelopment: false,
    displayName: "T3 Code (Alpha)",
    linuxWmClass: "t3code",
    linuxApplicationsDir: "/home/alice/.local/share/applications",
    appImagePath: Option.some("/home/alice/Applications/T3-Code.AppImage"),
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
    ...overrides,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const mockProcess = (exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeHandlerLayer = (
  recorded: RecordedRegistration,
  input: {
    readonly environment?: Record<string, unknown>;
    readonly xdgMimeExitCode?: number;
    readonly writeError?: PlatformError.PlatformError;
  } = {},
) =>
  DesktopLinuxUrlHandler.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, makeEnvironment(input.environment)),
        FileSystem.layerNoop({
          makeDirectory: (path) =>
            Effect.sync(() => {
              recorded.directories.push(path);
            }),
          writeFileString: (path, content) =>
            input.writeError
              ? Effect.fail(input.writeError)
              : Effect.sync(() => {
                  recorded.files.push({ path, content });
                }),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            recorded.commands.push({
              command: childProcess.command,
              args: childProcess.args,
            });
            return Effect.succeed(mockProcess(input.xdgMimeExitCode ?? 0));
          }),
        ),
      ),
    ),
  );

const runRegister = (
  recorded: RecordedRegistration,
  input: Parameters<typeof makeHandlerLayer>[1] = {},
) =>
  Effect.gen(function* () {
    const handler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
    yield* handler.register;
  }).pipe(Effect.provide(makeHandlerLayer(recorded, input)));

const emptyRecording = (): RecordedRegistration => ({
  directories: [],
  files: [],
  commands: [],
});

describe("DesktopLinuxUrlHandler", () => {
  it("renders a scheme-handler desktop entry with freedesktop Exec quoting", () => {
    const entry = DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
      displayName: "T3 Code (Nightly)",
      execTarget: '/home/al ice/Apps/T3 "100%" $HOME\\x.AppImage',
      scheme: "t3code",
    });

    assert.include(entry, "[Desktop Entry]");
    assert.include(entry, "Name=T3 Code (Nightly)");
    // Exec composes both escaping layers: a literal backslash becomes four
    // backslashes in the file, a quote three characters, a dollar sign two
    // backslashes plus the sign.
    assert.include(
      entry,
      'Exec="/home/al ice/Apps/T3 \\\\"100%%\\\\" \\\\$HOME\\\\\\\\x.AppImage" %U',
    );
    assert.include(entry, "NoDisplay=true");
    assert.notInclude(entry, "StartupWMClass=");
    assert.include(entry, "MimeType=x-scheme-handler/t3code;");
  });

  it("carries structured context on registration errors", () => {
    const writeError = new DesktopLinuxUrlHandler.DesktopLinuxUrlHandlerRegistrationError({
      step: "write-desktop-entry",
      scheme: "t3code",
      desktopEntryPath: "/home/alice/.local/share/applications/t3code-url-handler.desktop",
      cause: new Error("boom"),
    });
    assert.equal(
      writeError.message,
      "Failed to register the t3code:// URL handler (step: write-desktop-entry).",
    );
    assert.equal(
      writeError.desktopEntryPath,
      "/home/alice/.local/share/applications/t3code-url-handler.desktop",
    );

    const exitError = new DesktopLinuxUrlHandler.DesktopLinuxUrlHandlerRegistrationError({
      step: "set-default-handler",
      scheme: "t3code",
      exitCode: 4,
    });
    assert.equal(
      exitError.message,
      "Failed to register the t3code:// URL handler (step: set-default-handler, xdg-mime exit code 4).",
    );
  });

  it.effect("writes the handler entry and claims the scheme default via xdg-mime", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded);

      assert.deepEqual(recorded.directories, ["/home/alice/.local/share/applications"]);
      assert.equal(recorded.files.length, 1);
      assert.equal(
        recorded.files[0]?.path,
        "/home/alice/.local/share/applications/t3code-url-handler.desktop",
      );
      assert.include(
        recorded.files[0]?.content,
        'Exec="/home/alice/Applications/T3-Code.AppImage" %U',
      );
      assert.include(recorded.files[0]?.content, "MimeType=x-scheme-handler/t3code;");
      assert.deepEqual(recorded.commands, [
        {
          command: "xdg-mime",
          args: ["default", "t3code-url-handler.desktop", "x-scheme-handler/t3code"],
        },
      ]);
    });
  });

  it.effect("falls back to the process executable outside an AppImage", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, { environment: { appImagePath: Option.none() } });

      assert.include(
        recorded.files[0]?.content,
        `Exec=${DesktopLinuxUrlHandler.escapeDesktopEntryExecArgument(process.execPath)} %U`,
      );
    });
  });

  it.effect("does nothing on other platforms or unpackaged builds", () => {
    const nonLinux = emptyRecording();
    const unpackaged = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(nonLinux, { environment: { platform: "darwin" } });
      yield* runRegister(unpackaged, { environment: { isPackaged: false } });

      for (const recorded of [nonLinux, unpackaged]) {
        assert.deepEqual(recorded.directories, []);
        assert.deepEqual(recorded.files, []);
        assert.deepEqual(recorded.commands, []);
      }
    });
  });

  it.effect("never fails startup when registration cannot complete", () => {
    const xdgMimeFailed = emptyRecording();
    const writeFailed = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(xdgMimeFailed, { xdgMimeExitCode: 1 });
      yield* runRegister(writeFailed, {
        writeError: PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "writeFileString",
          description: "read-only filesystem",
          pathOrDescriptor: "/home/alice/.local/share/applications/t3code-url-handler.desktop",
        }),
      });

      assert.equal(xdgMimeFailed.files.length, 1);
      assert.deepEqual(writeFailed.commands, []);
    });
  });
});
