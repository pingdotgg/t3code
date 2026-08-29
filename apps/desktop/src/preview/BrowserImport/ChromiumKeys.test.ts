// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ChromiumKeyError, readLinuxSecret, resolveChromiumKeys } from "./ChromiumKeys.ts";

type CapturedCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly stdin?: string };
};

const secretToolLayer = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly capture?: (command: CapturedCommand) => void;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(input.stdout ?? "")),
          stderr: Stream.encodeText(Stream.make(input.stderr ?? "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ).pipe(Effect.tap(() => Effect.sync(() => input.capture?.(command as CapturedCommand)))),
    ),
  );

describe("Linux Chromium secrets", () => {
  it.effect("looks up the browser's libsecret application attribute", () => {
    let captured: CapturedCommand | undefined;
    return Effect.gen(function* () {
      const keys = yield* resolveChromiumKeys({
        platform: "linux",
        keychainService: "ignored macOS service",
        keychainAccount: "ignored macOS account",
        linuxSecretApplication: "msedge",
      });

      expect(captured?.command).toBe("secret-tool");
      expect(captured?.args).toEqual(["lookup", "application", "msedge"]);
      expect(captured?.options.stdin).toBe("ignore");
      expect(keys.cbcV10).toHaveLength(16);
      expect(keys.cbcV11).toHaveLength(16);
    }).pipe(
      Effect.provide(
        secretToolLayer({ stdout: "linux-secret\n", capture: (value) => (captured = value) }),
      ),
    );
  });

  it.effect("reports an unavailable Secret Service backend as a read failure", () =>
    Effect.gen(function* () {
      const error = yield* readLinuxSecret("chrome").pipe(Effect.flip);
      expect(error).toBeInstanceOf(ChromiumKeyError);
      expect(error.reason).toBe("readFailed");
    }).pipe(
      Effect.provide(
        secretToolLayer({ stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY", exitCode: 1 }),
      ),
    ),
  );

  it.effect("preserves trailing whitespace in the stored secret", () =>
    Effect.gen(function* () {
      const secret = yield* readLinuxSecret("chrome");
      expect(secret).toBe("linux-secret \t");
    }).pipe(Effect.provide(secretToolLayer({ stdout: "linux-secret \t\n" }))),
  );

  it.effect("reports a denied unlock prompt as approval needed", () =>
    Effect.gen(function* () {
      const error = yield* readLinuxSecret("brave").pipe(Effect.flip);
      expect(error).toBeInstanceOf(ChromiumKeyError);
      expect(error.reason).toBe("needsKeychainApproval");
    }).pipe(Effect.provide(secretToolLayer({ stderr: "Permission denied", exitCode: 1 }))),
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
    }).pipe(Effect.provide(secretToolLayer({ stderr: "Keyring is locked", exitCode: 1 }))),
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
        secretToolLayer({
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
    }).pipe(Effect.provide(secretToolLayer({ exitCode: 1 }))),
  );
});
