import { describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ChromiumKeyError,
  decodeWindowsWrappedKey,
  readLinuxSecret,
  resolveChromiumKeys,
  unwrapWindowsDpapiKey,
} from "./ChromiumKeys.ts";
import { LinuxBrowserSecretPath } from "./LinuxBrowserSecret.ts";

type CapturedCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly stdin?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  };
};

const helperLayer = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutStream?: Stream.Stream<Uint8Array>;
  readonly stderrStream?: Stream.Stream<Uint8Array>;
  readonly exitCode?: number;
  readonly spawnError?: PlatformError.PlatformError;
  readonly capture?: (command: CapturedCommand) => void;
}) =>
  Layer.merge(
    Layer.succeed(LinuxBrowserSecretPath, "/bundled/browser-secret/t3-browser-secret"),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        input.spawnError
          ? Effect.fail(input.spawnError)
          : Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: input.stdoutStream ?? Stream.encodeText(Stream.make(input.stdout ?? "")),
                stderr: input.stderrStream ?? Stream.encodeText(Stream.make(input.stderr ?? "")),
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            ).pipe(
              Effect.tap(() => Effect.sync(() => input.capture?.(command as CapturedCommand))),
            ),
      ),
    ),
  );

describe("Linux Chromium secrets", () => {
  it.effect("retains a missing helper failure alongside the keyring-free fallback", () =>
    Effect.gen(function* () {
      const keys = yield* resolveChromiumKeys({
        platform: "linux",
        keychainService: undefined,
        keychainAccount: undefined,
        linuxSecretApplication: "chromium",
      });
      expect(keys.cbcV10).toHaveLength(16);
      expect(keys.cbcV11).toBeUndefined();
      expect(keys.cbcV11Error?.reason).toBe("keychainUnavailable");
    }).pipe(
      Effect.provide(
        helperLayer({
          spawnError: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
          }),
        }),
      ),
    ),
  );

  it.effect("reports an unconfigured helper without searching PATH", () =>
    readLinuxSecret("chromium").pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe("keychainUnavailable"))),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("must not spawn")),
      ),
      Effect.provideService(LinuxBrowserSecretPath, undefined),
    ),
  );

  it.effect("looks up the browser's libsecret application attribute", () => {
    let captured: CapturedCommand | undefined;
    return Effect.gen(function* () {
      const keys = yield* resolveChromiumKeys({
        platform: "linux",
        keychainService: "ignored macOS service",
        keychainAccount: "ignored macOS account",
        linuxSecretApplication: "msedge",
      });

      expect(captured?.command).toBe("/bundled/browser-secret/t3-browser-secret");
      expect(captured?.args).toEqual(["msedge"]);
      expect(captured?.options.stdin).toBe("ignore");
      expect(keys.cbcV10).toHaveLength(16);
      expect(keys.cbcV11).toHaveLength(16);
    }).pipe(
      Effect.provide(
        helperLayer({ stdout: "linux-secret", capture: (value) => (captured = value) }),
      ),
    );
  });

  it.effect("reports an unavailable Secret Service backend as a read failure", () =>
    Effect.gen(function* () {
      const error = yield* readLinuxSecret("chrome").pipe(Effect.flip);
      expect(error).toBeInstanceOf(ChromiumKeyError);
      expect(error.reason).toBe("keychainUnavailable");
    }).pipe(
      Effect.provide(
        helperLayer({ stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY", exitCode: 1 }),
      ),
    ),
  );

  it.effect("preserves trailing whitespace in the stored secret", () =>
    Effect.gen(function* () {
      const secret = yield* readLinuxSecret("chrome");
      expect(secret).toBe("linux-secret \t\n");
    }).pipe(Effect.provide(helperLayer({ stdout: "linux-secret \t\n" }))),
  );

  it.effect("drains stdout and stderr concurrently", () =>
    Effect.gen(function* () {
      const stderrDrainStarted = yield* Deferred.make<void>();
      const stdout = Stream.fromEffect(Deferred.await(stderrDrainStarted)).pipe(
        Stream.flatMap(() => Stream.encodeText(Stream.make("linux-secret"))),
      );
      const stderr = Stream.fromEffect(Deferred.succeed(stderrDrainStarted, undefined)).pipe(
        Stream.drain,
      );

      const secret = yield* readLinuxSecret("chrome").pipe(
        Effect.provide(helperLayer({ stdoutStream: stdout, stderrStream: stderr })),
      );

      expect(secret).toBe("linux-secret");
    }),
  );

  it.effect(
    "preserves the desktop environment and identifies denial without parsing stderr",
    () => {
      let captured: CapturedCommand | undefined;
      return Effect.gen(function* () {
        const error = yield* readLinuxSecret("brave").pipe(Effect.flip);
        expect(error).toBeInstanceOf(ChromiumKeyError);
        expect(error.reason).toBe("needsKeychainApproval");
        expect(captured?.options.env?.LC_ALL).toBe("localized");
        expect(captured?.options.env?.PATH).toBe("/synthetic/bin");
        expect(captured?.options.env?.SESSION_MARKER).toBe("kept");
      }).pipe(
        Effect.provide(
          helperLayer({
            stderr: "Zugriff verweigert",
            exitCode: 3,
            capture: (value) => (captured = value),
          }),
        ),
        Effect.provideService(HostProcessEnvironment, {
          PATH: "/synthetic/bin",
          SESSION_MARKER: "kept",
          LC_ALL: "localized",
        }),
      );
    },
  );

  it.effect("does not discard a denied unlock prompt while resolving keys", () =>
    Effect.gen(function* () {
      const error = yield* resolveChromiumKeys({
        platform: "linux",
        keychainService: undefined,
        keychainAccount: undefined,
        linuxSecretApplication: "brave",
      }).pipe(Effect.flip);
      expect(error.reason).toBe("needsKeychainApproval");
    }).pipe(Effect.provide(helperLayer({ stderr: "Keyring is locked", exitCode: 3 }))),
  );

  it.effect("keeps the v10 fallback when the Secret Service backend is unavailable", () =>
    Effect.gen(function* () {
      const keys = yield* resolveChromiumKeys({
        platform: "linux",
        keychainService: undefined,
        keychainAccount: undefined,
        linuxSecretApplication: "chrome",
      });
      expect(keys.cbcV10).toHaveLength(16);
      expect(keys.cbcV11).toBeUndefined();
    }).pipe(
      Effect.provide(
        helperLayer({
          stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY",
          exitCode: 1,
        }),
      ),
    ),
  );

  it.effect("keeps the v10 fallback when no matching v11 secret exists", () =>
    Effect.gen(function* () {
      const keys = yield* resolveChromiumKeys({
        platform: "linux",
        keychainService: undefined,
        keychainAccount: undefined,
        linuxSecretApplication: "vivaldi",
      });
      expect(keys.cbcV10).toHaveLength(16);
      expect(keys.cbcV11).toBeUndefined();
    }).pipe(Effect.provide(helperLayer({ exitCode: 2 }))),
  );
});

describe("Windows Chromium secrets", () => {
  it.effect("accepts only DPAPI-wrapped non-app-bound keys", () =>
    Effect.gen(function* () {
      const wrapped = Buffer.from("wrapped-key");
      const encoded = Buffer.concat([Buffer.from("DPAPI"), wrapped]).toString("base64");
      const localState = `{"os_crypt":{"encrypted_key":"${encoded}"}}`;
      expect(yield* decodeWindowsWrappedKey(localState)).toEqual(wrapped);

      const appBound = yield* decodeWindowsWrappedKey(
        `{"os_crypt":{"encrypted_key":"${encoded}","app_bound_encrypted_key":"present"}}`,
      ).pipe(Effect.flip);
      expect(appBound.reason).toBe("unsupportedPlatform");

      const malformed = yield* decodeWindowsWrappedKey(
        `{"os_crypt":{"encrypted_key":"${wrapped.toString("base64")}"}}`,
      ).pipe(Effect.flip);
      expect(malformed.reason).toBe("readFailed");
    }),
  );

  it.effect("unwraps the binary key through PowerShell without placing it in argv", () => {
    let captured: CapturedCommand | undefined;
    const wrapped = Buffer.from("wrapped-key");
    const key = Buffer.from("0123456789abcdef0123456789abcdef");
    return Effect.gen(function* () {
      expect(yield* unwrapWindowsDpapiKey(wrapped)).toEqual(key);
      expect(captured?.command).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(captured?.args).toContain("-NonInteractive");
      expect(captured?.args.join(" ")).not.toContain(wrapped.toString("base64"));
    }).pipe(
      Effect.provide(
        helperLayer({ stdout: key.toString("base64"), capture: (value) => (captured = value) }),
      ),
      Effect.provideService(HostProcessEnvironment, { SystemRoot: "C:\\Windows" }),
    );
  });
});
