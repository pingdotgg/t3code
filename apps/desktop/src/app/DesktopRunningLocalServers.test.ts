import * as NodePath from "@effect/platform-node/NodePath";
import { EnvironmentId } from "@t3tools/contracts";
import { deriveServerRuntimeStatePath } from "@t3tools/shared/serverRuntimeState";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { make } from "./DesktopRunningLocalServers.ts";

const textEncoder = new TextEncoder();
const baseDir = "/test/.t3";
const environmentId = EnvironmentId.make("environment-local");
const descriptor = {
  environmentId,
  label: "Local development server",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.28",
  capabilities: { repositoryIdentity: true },
} as const;

const runtimeStatePath = (variant: "userdata" | "dev") =>
  deriveServerRuntimeStatePath({
    baseDir,
    variant,
    joinPath: (...segments) => segments.join("/"),
  });

const runtimeState = (input: { readonly pid: number; readonly origin: string }) =>
  JSON.stringify({
    version: 1,
    pid: input.pid,
    port: Number(new URL(input.origin).port),
    origin: input.origin,
    startedAt: "2026-01-01T00:00:00.000Z",
  });

const fakeFileSystemLayer = (files: ReadonlyMap<string, string>) =>
  FileSystem.layerNoop({
    readFileString: (path) => {
      const value = files.get(path);
      return value === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
            }),
          )
        : Effect.succeed(value);
    },
  });

const makeProcess = (input: {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(textEncoder.encode(input.stdout)),
    stderr: input.stderr ? Stream.make(textEncoder.encode(input.stderr)) : Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const makeTestService = (input: {
  readonly files: ReadonlyMap<string, string>;
  readonly probe?: typeof descriptor | null;
  readonly processIsAlive?: (pid: number) => boolean;
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) =>
  make({
    baseDir,
    backendEntryPath: "/bundle/apps/server/dist/bin.mjs",
    backendCwd: "/home/user",
    executablePath: "/bundle/electron",
    probeEnvironment: () => Effect.succeed(input.probe === undefined ? descriptor : input.probe),
    processIsAlive: input.processIsAlive ?? (() => true),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        fakeFileSystemLayer(input.files),
        NodePath.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          input.spawner ?? ChildProcessSpawner.make(() => Effect.die("unexpected pairing command")),
        ),
      ),
    ),
  );

describe("DesktopRunningLocalServers", () => {
  it.effect("discovers runtime state and confirms its persisted environment identity", () => {
    const statePath = runtimeStatePath("userdata");
    return Effect.gen(function* () {
      const service = yield* makeTestService({
        files: new Map([
          [statePath, runtimeState({ pid: 42, origin: "http://127.0.0.1:3773" })],
          ["/test/.t3/userdata/environment-id", environmentId],
        ]),
      });

      expect(yield* service.discover).toEqual([
        {
          statePath,
          baseDir,
          variant: "userdata",
          pid: 42,
          httpBaseUrl: "http://127.0.0.1:3773",
          startedAt: "2026-01-01T00:00:00.000Z",
          environmentId,
          label: descriptor.label,
        },
      ]);
    });
  });

  it.effect(
    "skips dead processes before probing and descriptors for another state directory",
    () => {
      const userdataPath = runtimeStatePath("userdata");
      const devPath = runtimeStatePath("dev");
      let probeCount = 0;
      return Effect.gen(function* () {
        const service = yield* make({
          baseDir,
          backendEntryPath: "/bundle/apps/server/dist/bin.mjs",
          backendCwd: "/home/user",
          executablePath: "/bundle/electron",
          probeEnvironment: () => {
            probeCount += 1;
            return Effect.succeed({
              ...descriptor,
              environmentId: EnvironmentId.make("another-environment"),
            });
          },
          processIsAlive: (pid) => pid !== 41,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              fakeFileSystemLayer(
                new Map([
                  [userdataPath, runtimeState({ pid: 41, origin: "http://127.0.0.1:3773" })],
                  ["/test/.t3/userdata/environment-id", environmentId],
                  [devPath, runtimeState({ pid: 42, origin: "http://127.0.0.1:3774" })],
                  ["/test/.t3/dev/environment-id", environmentId],
                ]),
              ),
              NodePath.layer,
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() => Effect.die("unexpected pairing command")),
              ),
            ),
          ),
        );

        expect(yield* service.discover).toEqual([]);
        expect(probeCount).toBe(1);
      });
    },
  );

  it.effect("pairs through the bundled CLI and validates its JSON result", () => {
    const statePath = runtimeStatePath("userdata");
    let command: ChildProcess.StandardCommand | null = null;
    const spawner = ChildProcessSpawner.make((candidate) => {
      assert.equal(candidate._tag, "StandardCommand");
      if (candidate._tag === "StandardCommand") command = candidate;
      return Effect.succeed(
        makeProcess({
          stdout: JSON.stringify({
            pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
            token: "PAIRCODE",
            expiresAt: "2099-01-01T00:00:00.000Z",
            origin: "http://127.0.0.1:3773",
            environmentId,
            label: descriptor.label,
          }),
        }),
      );
    });

    return Effect.gen(function* () {
      const service = yield* makeTestService({
        files: new Map([
          [statePath, runtimeState({ pid: 42, origin: "http://127.0.0.1:3773" })],
          ["/test/.t3/userdata/environment-id", environmentId],
        ]),
        spawner,
      });

      expect(yield* service.pairLocalServer(environmentId)).toEqual({
        pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
        pairingExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(command?.command).toBe("/bundle/electron");
      expect(command?.args).toEqual([
        "/bundle/apps/server/dist/bin.mjs",
        "pair",
        "--json",
        "--label",
        "T3 Code Desktop",
        "--base-dir",
        baseDir,
      ]);
      expect(command?.options.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    });
  });

  it.effect("rejects malformed JSON and pairing URLs that retarget the credential", () => {
    const statePath = runtimeStatePath("userdata");
    const files = new Map([
      [statePath, runtimeState({ pid: 42, origin: "http://127.0.0.1:3773" })],
      ["/test/.t3/userdata/environment-id", environmentId],
    ]);
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeProcess({
          stdout: JSON.stringify({
            pairingUrl:
              "http://127.0.0.1:3773/pair?host=https%3A%2F%2Fattacker.example#token=PAIRCODE",
            token: "PAIRCODE",
            expiresAt: "2099-01-01T00:00:00.000Z",
            origin: "http://127.0.0.1:3773",
            environmentId,
            label: descriptor.label,
          }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* makeTestService({ files, spawner });
      const invalidUrl = yield* service.pairLocalServer(environmentId).pipe(Effect.flip);
      expect(invalidUrl.reason).toBe("request_failed");
      expect(invalidUrl.detail).toContain("invalid pairing link");

      const malformedService = yield* makeTestService({
        files,
        spawner: ChildProcessSpawner.make(() =>
          Effect.succeed(makeProcess({ stdout: "not-json" })),
        ),
      });
      const malformed = yield* malformedService.pairLocalServer(environmentId).pipe(Effect.flip);
      expect(malformed.reason).toBe("request_failed");
      expect(malformed.detail).toContain("invalid JSON");
    });
  });
});
