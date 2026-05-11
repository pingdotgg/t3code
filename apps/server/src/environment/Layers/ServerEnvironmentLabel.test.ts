import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  ServerEnvironmentLabelCommandError,
  ServerEnvironmentLabelCommandRunner,
  resolveServerEnvironmentLabel,
} from "./ServerEnvironmentLabel.ts";
const NoopFileSystemLayer = FileSystem.layerNoop({});
const NoopCommandRunnerLayer = Layer.mock(ServerEnvironmentLabelCommandRunner)({});

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
}

function commandRunnerLayer(input: {
  readonly calls?: CommandCall[];
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Effect.Effect<
    { readonly stdout: string; readonly exitCode: number },
    ServerEnvironmentLabelCommandError
  >;
}) {
  return Layer.mock(ServerEnvironmentLabelCommandRunner)({
    run: (command, args) =>
      Effect.gen(function* () {
        input.calls?.push({ command, args });
        return yield* input.run(command, args);
      }),
  });
}

function testLayer(commandLayer = NoopCommandRunnerLayer) {
  return Layer.merge(NoopFileSystemLayer, commandLayer);
}

describe("resolveServerEnvironmentLabel", () => {
  it.effect("uses hostname fallback regardless of launch mode", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "win32",
        hostname: "macbook-pro",
      }).pipe(Effect.provide(testLayer()));

      assert.equal(result, "macbook-pro");
    }),
  );

  it.effect("prefers the macOS ComputerName", () =>
    Effect.gen(function* () {
      const calls: CommandCall[] = [];

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "darwin",
        hostname: "macbook-pro",
      }).pipe(
        Effect.provide(
          testLayer(
            commandRunnerLayer({
              calls,
              run: () => Effect.succeed({ stdout: " Julius's MacBook Pro \n", exitCode: 0 }),
            }),
          ),
        ),
      );

      assert.equal(result, "Julius's MacBook Pro");
      assert.deepEqual(calls, [{ command: "scutil", args: ["--get", "ComputerName"] }]);
    }),
  );

  it.effect("prefers Linux PRETTY_HOSTNAME from machine-info", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "linux",
        hostname: "buildbox",
      }).pipe(
        Effect.provide(
          Layer.merge(
            FileSystem.layerNoop({
              exists: (path) => Effect.succeed(path === "/etc/machine-info"),
              readFileString: (path) =>
                path === "/etc/machine-info"
                  ? Effect.succeed('PRETTY_HOSTNAME="Build Agent 01"\nICON_NAME="computer-vm"\n')
                  : Effect.succeed(""),
            }),
            NoopCommandRunnerLayer,
          ),
        ),
      );

      assert.equal(result, "Build Agent 01");
    }),
  );

  it.effect("falls back to hostnamectl pretty hostname on Linux", () =>
    Effect.gen(function* () {
      const calls: CommandCall[] = [];

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "linux",
        hostname: "runner-01",
      }).pipe(
        Effect.provide(
          testLayer(
            commandRunnerLayer({
              calls,
              run: () => Effect.succeed({ stdout: "CI Runner\n", exitCode: 0 }),
            }),
          ),
        ),
      );

      assert.equal(result, "CI Runner");
      assert.deepEqual(calls, [{ command: "hostnamectl", args: ["--pretty"] }]);
    }),
  );

  it.effect("falls back to the hostname when friendly labels are unavailable", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "win32",
        hostname: "JULIUS-LAPTOP",
      }).pipe(Effect.provide(testLayer()));

      assert.equal(result, "JULIUS-LAPTOP");
    }),
  );

  it.effect("falls back to the hostname when the friendly-label command is missing", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "darwin",
        hostname: "macbook-pro",
      }).pipe(
        Effect.provide(
          testLayer(
            commandRunnerLayer({
              run: (command, args) =>
                Effect.fail(
                  new ServerEnvironmentLabelCommandError({
                    command,
                    args: [...args],
                    message: "spawn scutil ENOENT",
                  }),
                ),
            }),
          ),
        ),
      );

      assert.equal(result, "macbook-pro");
    }),
  );

  it.effect("falls back to the cwd basename when the hostname is blank", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "linux",
        hostname: "   ",
      }).pipe(
        Effect.provide(
          testLayer(
            commandRunnerLayer({
              run: () => Effect.succeed({ stdout: " ", exitCode: 0 }),
            }),
          ),
        ),
      );

      assert.equal(result, "t3code");
    }),
  );
});
