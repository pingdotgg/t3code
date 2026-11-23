import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackgroundService from "./DesktopBackgroundService.ts";

const textEncoder = new TextEncoder();

const makeMockSpawner = (
  handler: (args: ReadonlyArray<string>) => {
    readonly exitCode: number;
    readonly stdout?: string;
    readonly stderr?: string;
  },
) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") {
        return Effect.die("Expected StandardCommand");
      }
      const stringArgs = command.args.map((arg) => (typeof arg === "string" ? arg : String(arg)));
      calls.push(stringArgs);
      const outcome = handler(stringArgs);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(456),
          stdout: outcome.stdout
            ? Stream.succeed(textEncoder.encode(outcome.stdout))
            : Stream.empty,
          stderr: outcome.stderr
            ? Stream.succeed(textEncoder.encode(outcome.stderr))
            : Stream.empty,
          all: Stream.empty,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(outcome.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
        }),
      );
    }),
  );
  return { calls, layer };
};

const withServiceTest = <A, E>(
  options: {
    readonly httpStatus?: number;
    readonly spawner?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
    readonly backgroundServiceEnabled?: boolean;
  },
  run: (input: {
    readonly home: string;
    readonly userdata: string;
    readonly service: DesktopBackgroundService.DesktopBackgroundService["Service"];
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-bg-service-" });
    const userdata = `${home}/userdata`;
    yield* fs.makeDirectory(userdata, { recursive: true });
    const envLayer = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: home,
      platform: "win32",
      processArch: "x64",
      appVersion: "0.1.11",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/missing/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: home })),
      ),
    );
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ environmentId: "env-1" }), {
              status: options.httpStatus ?? 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      ),
    );
    const settingsLayer = DesktopAppSettings.layerTest({
      ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
      backgroundServiceEnabled: options.backgroundServiceEnabled ?? false,
    });
    const serviceLayer = DesktopBackgroundService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          envLayer,
          settingsLayer,
          NodeServices.layer,
          httpLayer,
          options.spawner ?? makeMockSpawner(() => ({ exitCode: 0, stdout: "" })).layer,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* DesktopBackgroundService.DesktopBackgroundService;
      return yield* run({ home, userdata, service });
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(Effect.provide(NodeServices.layer));

describe("DesktopBackgroundService", () => {
  it.effect("attaches immediately when a live serviceManaged server holds the ownership lock", () =>
    withServiceTest({}, ({ userdata, service }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${userdata}/server-runtime.json`,
          JSON.stringify({
            version: 1,
            pid: process.pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-11-23T00:00:00.000Z",
            serviceManaged: true,
            serverVersion: "0.1.11",
          }),
        );
        const lock = new NodeSqlite.DatabaseSync(`${userdata}/server-owner.sqlite`);
        lock.exec("BEGIN EXCLUSIVE;");
        try {
          const attached = yield* service.tryAttach;
          assert.isTrue(Option.isSome(attached));
          assert.strictEqual(Option.getOrThrow(attached).pid, process.pid);
          assert.strictEqual(Option.getOrThrow(attached).port, 3773);
          assert.strictEqual(
            Option.getOrThrow(attached).httpBaseUrl.href,
            "http://127.0.0.1:3773/",
          );
          assert.strictEqual(Option.getOrThrow(attached).label, "Windows");
          assert.deepStrictEqual(yield* service.status, {
            supported: true,
            enabled: true,
            running: true,
            attached: true,
            externalService: true,
            version: "0.1.11",
          });
        } finally {
          lock.close();
        }
      }),
    ),
  );

  it.effect("does not attach when the owner is not serviceManaged", () =>
    withServiceTest({}, ({ userdata, service }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${userdata}/server-runtime.json`,
          JSON.stringify({
            version: 1,
            pid: process.pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-11-23T00:00:00.000Z",
          }),
        );
        const lock = new NodeSqlite.DatabaseSync(`${userdata}/server-owner.sqlite`);
        lock.exec("BEGIN EXCLUSIVE;");
        try {
          assert.isTrue(Option.isNone(yield* service.tryAttach));
        } finally {
          lock.close();
        }
      }),
    ),
  );

  it.effect("mints an administrative bearer token and reads instant settings status", () => {
    const spawner = makeMockSpawner((args) => {
      if (args.includes("issue")) {
        return { exitCode: 0, stdout: "service-bearer-token\n" };
      }
      return { exitCode: 0, stdout: "" };
    });
    return withServiceTest(
      { spawner: spawner.layer, backgroundServiceEnabled: true },
      ({ service }) =>
        Effect.gen(function* () {
          const token = yield* service.issueBearerToken;
          assert.strictEqual(token, "service-bearer-token");
          const status = yield* service.status;
          assert.deepStrictEqual(status, {
            supported: true,
            enabled: true,
            running: false,
            attached: false,
            externalService: false,
            version: null,
          });
          const issueCall = spawner.calls.find((call) => call.includes("issue"));
          assert.isDefined(issueCall);
          assert.include(issueCall ?? [], "relay:configure");
          assert.include(issueCall ?? [], "--token-only");
        }),
    );
  });
});
