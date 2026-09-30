/**
 * Live check of the OpenCode 2 server lifecycle against a real binary:
 *
 *   OPENCODE2_BIN=/path/to/opencode vp test run src/provider/opencode2/OpenCode2Server.live.test.ts
 *
 * No model is called. The server runs with isolated HOME and XDG directories.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";

const binaryPath = process.env.OPENCODE2_BIN;

// A negative pid probes the whole process group, which T3 stops as one unit.
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(binaryPath !== undefined)("OpenCode2Server live", () => {
  it.live(
    "spawns one authenticated server per instance and stops it by PID",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode2-server-live-" });
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        yield* fs.makeDirectory(first);
        yield* fs.makeDirectory(second);
        const environment = {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          // Ignored: the T3 password is the only one the server sees.
          OPENCODE_SERVER_PASSWORD: "ambient-password",
        };

        // The instance owns its server: building the layer spawns nothing, and
        // closing its scope stops whatever it spawned.
        const instanceScope = yield* Scope.make();
        const server = Context.get(
          yield* Layer.buildWithScope(
            OpenCode2Server.layer({
              binaryPath: binaryPath!,
              serverUrl: "",
              serverPassword: Redacted.make(""),
              directory: first,
              environment,
            }),
            instanceScope,
          ),
          OpenCode2Server.OpenCode2Server,
        );

        const spawned = yield* server.withConnection((connection) =>
          Effect.gen(function* () {
            const info = yield* connection.client.server.info();
            const session = yield* connection.client.session.create({
              title: "first location",
              location: { directory: first } as never,
            });
            return { ...connection, pid: info.pid, session };
          }),
        );
        assert.strictEqual(spawned.version, "2.0.18");
        assert.isFalse(spawned.external);
        assert.isTrue(isAlive(spawned.pid));

        // A second location is served by the same process.
        const secondLocation = yield* server.withConnection((connection) =>
          Effect.gen(function* () {
            const info = yield* connection.client.server.info();
            const session = yield* connection.client.session.create({
              title: "second location",
              location: { directory: second } as never,
            });
            return { url: connection.url, pid: info.pid, session };
          }),
        );
        assert.strictEqual(secondLocation.url, spawned.url);
        assert.strictEqual(secondLocation.pid, spawned.pid);
        assert.strictEqual(secondLocation.session.location.directory, second);
        assert.strictEqual(spawned.session.location.directory, first);

        // External URL: the configured password works, a wrong one is a 401.
        const external = yield* OpenCode2Server.make({
          binaryPath: binaryPath!,
          serverUrl: spawned.url,
          serverPassword: Redacted.make("wrong-password"),
          directory: first,
          environment,
        });
        const rejected = yield* external.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(rejected.detail, "rejected the server password");
        const ambient = yield* OpenCode2Server.make({
          binaryPath: binaryPath!,
          serverUrl: spawned.url,
          serverPassword: Redacted.make(environment.OPENCODE_SERVER_PASSWORD ?? ""),
          directory: first,
          environment,
        });
        const ambientRejected = yield* ambient.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(ambientRejected.detail, "rejected the server password");

        // Closing the instance stops the server it spawned.
        yield* Scope.close(instanceScope, Exit.void);
        for (let attempt = 0; attempt < 50 && isAlive(-spawned.pid); attempt++) {
          yield* Effect.sleep("100 millis");
        }
        assert.isFalse(isAlive(spawned.pid), `opencode serve ${spawned.pid} outlived its instance`);
        assert.isFalse(isAlive(-spawned.pid), `a process in group ${spawned.pid} outlived it`);
        const unreachable = yield* external.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(unreachable.detail, "Could not reach the OpenCode server");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(OpenCode2Client.layer, OpenCodeRuntimeLive).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
          ),
        ),
      ),
    60_000,
  );
});
