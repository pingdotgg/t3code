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
  readonly executableChecks: string[];
}

const normalizeAbsolutePath = (value: string): string => {
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

const makeEnvironment = (overrides: Record<string, unknown> = {}) =>
  DesktopEnvironment.DesktopEnvironment.of({
    platform: "linux",
    isPackaged: true,
    isDevelopment: false,
    displayName: "T3 Code (Alpha)",
    linuxWmClass: "t3code",
    linuxApplicationsDir: "/home/alice/.local/share/applications",
    appImagePath: Option.some("/home/alice/Applications/T3-Code.AppImage"),
    linuxUrlHandlerExecutableOverride: Option.none(),
    path: {
      join: (...parts: ReadonlyArray<string>) => parts.join("/"),
      isAbsolute: (value: string) => value.startsWith("/"),
      normalize: normalizeAbsolutePath,
    },
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
    readonly executableOverrideMode?: number;
    readonly executableOverrideType?: FileSystem.File.Type;
    readonly executableOverrideStatError?: PlatformError.PlatformError;
    readonly executableOverrideExitCode?: number;
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
          stat: (path) =>
            Effect.sync(() => recorded.executableChecks.push(path)).pipe(
              Effect.flatMap(() =>
                input.executableOverrideStatError
                  ? Effect.fail(input.executableOverrideStatError)
                  : Effect.succeed({
                      type: input.executableOverrideType ?? "File",
                      mtime: Option.none(),
                      atime: Option.none(),
                      birthtime: Option.none(),
                      dev: 0,
                      ino: Option.none(),
                      mode: input.executableOverrideMode ?? 0o755,
                      nlink: Option.none(),
                      uid: Option.none(),
                      gid: Option.none(),
                      rdev: Option.none(),
                      size: FileSystem.Size(0),
                      blksize: Option.none(),
                      blocks: Option.none(),
                    } satisfies FileSystem.File.Info),
              ),
            ),
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
            return Effect.succeed(
              mockProcess(
                childProcess.command === "test"
                  ? (input.executableOverrideExitCode ?? 0)
                  : (input.xdgMimeExitCode ?? 0),
              ),
            );
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
  executableChecks: [],
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

  it("renders a validated explicit launcher as an unquoted Exec token", () => {
    const execTarget = "/home/alice/bin/t3code-nightly";
    assert.isTrue(DesktopLinuxUrlHandler.isSafeUnquotedDesktopEntryExecTarget(execTarget));

    const entry = DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
      displayName: "T3 Code (Nightly)",
      execTarget,
      unquotedExecTarget: true,
      scheme: "t3code",
    });

    assert.include(entry, `Exec=${execTarget} %U`);
    assert.notInclude(entry, `Exec="${execTarget}" %U`);

    const unsafeEntry = DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
      displayName: "T3 Code (Nightly)",
      execTarget: "/home/alice/bin/t3 code",
      unquotedExecTarget: true,
      scheme: "t3code",
    });
    assert.include(unsafeEntry, 'Exec="/home/alice/bin/t3 code" %U');
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

  it.effect("keeps an explicit executable stable across registrations", () => {
    const first = emptyRecording();
    const restarted = emptyRecording();
    const executableOverride = Option.some("/home/alice/bin/../bin/t3code-nightly");

    return Effect.gen(function* () {
      yield* runRegister(first, {
        environment: { linuxUrlHandlerExecutableOverride: executableOverride },
      });
      yield* runRegister(restarted, {
        environment: {
          appImagePath: Option.some("/home/alice/Applications/T3-Code-New.AppImage"),
          linuxUrlHandlerExecutableOverride: executableOverride,
        },
      });

      for (const recorded of [first, restarted]) {
        assert.deepEqual(recorded.executableChecks, ["/home/alice/bin/t3code-nightly"]);
        assert.include(recorded.files[0]?.content, "Exec=/home/alice/bin/t3code-nightly %U");
        assert.deepEqual(recorded.commands, [
          { command: "test", args: ["-x", "/home/alice/bin/t3code-nightly"] },
          {
            command: "xdg-mime",
            args: ["default", "t3code-url-handler.desktop", "x-scheme-handler/t3code"],
          },
        ]);
      }
    });
  });

  it.effect("falls back when the executable override is invalid", () => {
    const relative = emptyRecording();
    const unsafe = emptyRecording();
    const notExecutable = emptyRecording();
    const missing = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(relative, {
        environment: {
          linuxUrlHandlerExecutableOverride: Option.some("bin/t3code-nightly"),
        },
      });
      yield* runRegister(notExecutable, {
        environment: {
          linuxUrlHandlerExecutableOverride: Option.some("/home/alice/bin/t3code-nightly"),
        },
        // A raw mode-bit check would accept this group-only executable, even
        // when the current user cannot execute it. The effective-user probe
        // is authoritative.
        executableOverrideMode: 0o010,
        executableOverrideExitCode: 1,
      });
      yield* runRegister(unsafe, {
        environment: {
          linuxUrlHandlerExecutableOverride: Option.some("/home/alice/bin/t3 code"),
        },
      });
      yield* runRegister(missing, {
        environment: {
          linuxUrlHandlerExecutableOverride: Option.some("/home/alice/bin/missing"),
        },
        executableOverrideStatError: PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "stat",
          pathOrDescriptor: "/home/alice/bin/missing",
        }),
      });

      assert.deepEqual(relative.executableChecks, []);
      assert.deepEqual(unsafe.executableChecks, []);
      assert.deepEqual(notExecutable.executableChecks, ["/home/alice/bin/t3code-nightly"]);
      assert.deepEqual(missing.executableChecks, ["/home/alice/bin/missing"]);
      for (const recorded of [relative, unsafe, notExecutable, missing]) {
        assert.include(
          recorded.files[0]?.content,
          'Exec="/home/alice/Applications/T3-Code.AppImage" %U',
        );
      }
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
