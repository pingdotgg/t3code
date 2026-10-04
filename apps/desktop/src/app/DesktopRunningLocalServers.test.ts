import * as NodePath from "@effect/platform-node/NodePath";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
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

const statePath = deriveServerRuntimeStatePath({
  baseDir,
  variant: "userdata",
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

const homeFiles = new Map([
  [statePath, runtimeState({ pid: 42, origin: "http://127.0.0.1:3773" })],
  ["/test/.t3/userdata/environment-id", environmentId],
]);

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

const pairOutput = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    pairingUrl: "http://localhost:3773/pair#token=PAIRCODE",
    token: "PAIRCODE",
    expiresAt: "2099-01-01T00:00:00.000Z",
    environmentId,
    label: descriptor.label,
    ...overrides,
  });

const makeTestService = (input: {
  readonly files?: ReadonlyMap<string, string>;
  readonly probe?: (httpBaseUrl: string) => ExecutionEnvironmentDescriptor | null;
  readonly processIsAlive?: (pid: number) => boolean;
  readonly runsOwnBackend?: boolean;
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) =>
  make({
    baseDir,
    backendEntryPath: "/bundle/apps/server/dist/bin.mjs",
    backendCwd: "/home/user",
    executablePath: "/bundle/electron",
    bundledServerVersion: descriptor.serverVersion,
    runsOwnBackend: Effect.succeed(input.runsOwnBackend ?? false),
    probeEnvironment: (httpBaseUrl) =>
      Effect.succeed(input.probe === undefined ? descriptor : input.probe(httpBaseUrl)),
    processIsAlive: input.processIsAlive ?? (() => true),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        fakeFileSystemLayer(input.files ?? homeFiles),
        NodePath.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          input.spawner ?? ChildProcessSpawner.make(() => Effect.die("unexpected pairing command")),
        ),
      ),
    ),
  );

const pairSpawner = (stdout: string) =>
  ChildProcessSpawner.make(() => Effect.succeed(makeProcess({ stdout })));

describe("DesktopRunningLocalServers", () => {
  it.effect("discovers the home server and confirms its persisted environment identity", () =>
    Effect.gen(function* () {
      const service = yield* makeTestService({});

      expect(yield* service.discover).toEqual([
        {
          environmentId,
          label: descriptor.label,
          httpBaseUrl: "http://127.0.0.1:3773",
          serverVersion: descriptor.serverVersion,
          pairing: "available",
        },
      ]);
    }),
  );

  it.effect("skips dead processes and descriptors for another state directory", () => {
    let probeCount = 0;
    return Effect.gen(function* () {
      const dead = yield* makeTestService({
        processIsAlive: () => false,
        probe: () => {
          probeCount += 1;
          return descriptor;
        },
      });
      expect(yield* dead.discover).toEqual([]);
      expect(probeCount).toBe(0);

      const foreign = yield* makeTestService({
        probe: () => ({ ...descriptor, environmentId: EnvironmentId.make("another-environment") }),
      });
      expect(yield* foreign.discover).toEqual([]);
    });
  });

  it.effect("excludes the backend this launch runs itself", () =>
    Effect.gen(function* () {
      const service = yield* makeTestService({ runsOwnBackend: true });
      expect(yield* service.discover).toEqual([]);
    }),
  );

  it.effect("pairs through the bundled CLI and links to the discovered origin", () => {
    let command: ChildProcess.StandardCommand | null = null;
    const spawner = ChildProcessSpawner.make((candidate) => {
      assert.equal(candidate._tag, "StandardCommand");
      if (candidate._tag === "StandardCommand") command = candidate;
      return Effect.succeed(makeProcess({ stdout: `${pairOutput()}\n` }));
    });

    return Effect.gen(function* () {
      const service = yield* makeTestService({ spawner });

      expect(yield* service.pairLocalServer(environmentId)).toEqual({
        pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
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

  it.effect("refuses to run a different version's pairing command against the server", () =>
    Effect.gen(function* () {
      const service = yield* makeTestService({
        probe: () => ({ ...descriptor, serverVersion: "0.0.29" }),
      });
      const [server] = yield* service.discover;
      expect(server?.pairing).toBe("version-mismatch");

      const error = yield* service.pairLocalServer(environmentId).pipe(Effect.flip);
      expect(error.reason).toBe("version_mismatch");
      expect(error.detail).toContain("0.0.29");
    }),
  );

  it.effect("rejects malformed output without keeping it, and other environments", () =>
    Effect.gen(function* () {
      const malformed = yield* makeTestService({
        spawner: pairSpawner('{"token":"PAIRCODE"'),
      });
      const malformedError = yield* malformed.pairLocalServer(environmentId).pipe(Effect.flip);
      expect(malformedError.reason).toBe("request_failed");
      expect(malformedError.cause).toBeUndefined();
      expect(malformedError.detail).not.toContain("PAIRCODE");

      const otherEnvironment = yield* makeTestService({
        spawner: pairSpawner(pairOutput({ environmentId: "another-environment" })),
      });
      const otherError = yield* otherEnvironment.pairLocalServer(environmentId).pipe(Effect.flip);
      expect(otherError.reason).toBe("request_failed");
    }),
  );
});
