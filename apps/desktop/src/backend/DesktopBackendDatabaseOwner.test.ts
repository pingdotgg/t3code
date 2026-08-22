import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  DesktopBackendDatabaseOwnedError,
  ensureDesktopBackendDatabaseAvailable,
} from "./DesktopBackendDatabaseOwner.ts";

const descriptor = {
  environmentId: "local-environment",
  label: "Local environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.34",
  capabilities: {},
};

const runtimeState = '{"version":1,"pid":12345,"origin":"http://127.0.0.1:3773"}';

const withStateDir = <A, E, R>(
  effect: (input: {
    readonly stateDir: string;
    readonly statePath: string;
    readonly requestCount: Ref.Ref<number>;
  }) => Effect.Effect<A, E, R>,
  responseStatus = 200,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-database-owner-test-",
    });
    const statePath = `${stateDir}/server-runtime.json`;
    const requestCount = yield* Ref.make(0);
    const httpClientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Ref.update(requestCount, (count) => count + 1).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(descriptor), {
                status: responseStatus,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
      ),
    );
    return yield* effect({ stateDir, statePath, requestCount }).pipe(
      Effect.provide(httpClientLayer),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const ensureAvailable = (input: {
  readonly stateDir: string;
  readonly isProcessAlive: (pid: number) => boolean;
}) =>
  ensureDesktopBackendDatabaseAvailable({
    stateDir: input.stateDir,
    joinPath: (...parts) => parts.join("/"),
    isProcessAlive: input.isProcessAlive,
  });

describe("DesktopBackendDatabaseOwner", () => {
  it.effect("allows startup when no runtime state exists", () =>
    withStateDir(({ stateDir, requestCount }) =>
      Effect.gen(function* () {
        yield* ensureAvailable({ stateDir, isProcessAlive: () => true });
        assert.equal(yield* Ref.get(requestCount), 0);
      }),
    ),
  );

  it.effect("allows startup when the recorded process is gone", () =>
    withStateDir(({ stateDir, statePath, requestCount }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(statePath, runtimeState);

        yield* ensureAvailable({ stateDir, isProcessAlive: () => false });
        assert.equal(yield* Ref.get(requestCount), 0);
      }),
    ),
  );

  it.effect("allows startup when the recorded endpoint is not a live T3 server", () =>
    withStateDir(
      ({ stateDir, statePath, requestCount }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.writeFileString(statePath, runtimeState);

          yield* ensureAvailable({ stateDir, isProcessAlive: () => true });
          assert.equal(yield* Ref.get(requestCount), 1);
        }),
      404,
    ),
  );

  it.effect("blocks startup when a live T3 server owns the database", () =>
    withStateDir(({ stateDir, statePath, requestCount }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(statePath, runtimeState);

        const error = yield* ensureAvailable({
          stateDir,
          isProcessAlive: () => true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, DesktopBackendDatabaseOwnedError);
        assert.equal(error.stateDir, stateDir);
        assert.equal(error.origin, "http://127.0.0.1:3773");
        assert.equal(error.pid, 12_345);
        assert.include(error.message, "Starting another backend with the same database is unsafe.");
        assert.equal(yield* Ref.get(requestCount), 1);
      }),
    ),
  );
});
