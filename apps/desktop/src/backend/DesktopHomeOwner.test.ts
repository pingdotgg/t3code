// @effect-diagnostics nodeBuiltinImport:off -- The fixture signs a challenge on the actual TCP listener the desktop verifies.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeSqlite from "node:sqlite";

import * as NodeCryptoServices from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { lanDiscoveryProofMessage } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopHomeOwner from "./DesktopHomeOwner.ts";

const withTempHome = <A, E, R>(
  run: (
    userdata: string,
  ) => Effect.Effect<
    A,
    E,
    DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | Path.Path | R
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-home-owner-" });
    yield* fs.makeDirectory(`${home}/userdata`, { recursive: true });
    return yield* run(`${home}/userdata`).pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: home,
          platform: "linux",
          processArch: "x64",
          appVersion: "0.0.0",
          appPath: home,
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: home })),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const readOwnerWithRuntimeFile = (contents: string | undefined) =>
  withTempHome((userdata) =>
    Effect.gen(function* () {
      if (contents !== undefined) {
        yield* (yield* FileSystem.FileSystem).writeFileString(
          `${userdata}/server-runtime.json`,
          contents,
        );
      }
      return yield* DesktopHomeOwner.readLiveHomeOwner();
    }),
  );

describe("DesktopHomeOwner.readLiveHomeOwner", () => {
  it.effect("reports a live server recorded in server-runtime.json", () =>
    Effect.gen(function* () {
      const owner = yield* readOwnerWithRuntimeFile(
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 3790,
          origin: "http://127.0.0.1:3790",
          startedAt: "2026-01-01T00:00:00.000Z",
          serverVersion: "1.2.3",
        }),
      );
      assert.deepStrictEqual(
        owner,
        Option.some({ pid: process.pid, port: 3790, serverVersion: "1.2.3" }),
      );
      assert.include(
        DesktopHomeOwner.homeOwnedMessage(owner),
        `PID ${process.pid}, port 3790, version 1.2.3`,
      );
    }),
  );

  it.effect("ignores a missing, malformed or dead owner record", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* readOwnerWithRuntimeFile(undefined)));
      assert.isTrue(Option.isNone(yield* readOwnerWithRuntimeFile("{not json")));
      assert.isTrue(
        Option.isNone(yield* readOwnerWithRuntimeFile(JSON.stringify({ pid: 0, port: 3790 }))),
      );
    }),
  );
});

describe("DesktopHomeOwner.awaitHomeOwnershipRelease", () => {
  it.effect("waits for a shutting-down owner to release the lock, then gives up", () =>
    withTempHome((userdata) =>
      Effect.gen(function* () {
        assert.isTrue(yield* DesktopHomeOwner.awaitHomeOwnershipRelease());

        const lock = new NodeSqlite.DatabaseSync(`${userdata}/server-owner.sqlite`);
        lock.exec("BEGIN EXCLUSIVE;");
        const released = yield* Effect.forkChild(DesktopHomeOwner.awaitHomeOwnershipRelease());
        yield* TestClock.adjust("5 seconds");
        lock.close();
        yield* TestClock.adjust("1 second");
        assert.isTrue(yield* Fiber.join(released));

        const held = new NodeSqlite.DatabaseSync(`${userdata}/server-owner.sqlite`);
        held.exec("BEGIN EXCLUSIVE;");
        const owned = yield* Effect.forkChild(DesktopHomeOwner.awaitHomeOwnershipRelease());
        yield* TestClock.adjust("1 minute");
        assert.isFalse(yield* Fiber.join(owned));
        held.close();
      }),
    ),
  );
});

describe("DesktopHomeOwner.authenticateHomeOwner", () => {
  it.live("attaches only to the home that signed the session and revokes it at exit", () =>
    withTempHome((userdata) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* DesktopEnvironment.DesktopEnvironment;
        const environmentId = "bde15824-93d9-4339-a70a-599fcbe36b27";
        const sessionId = "9f907b0c-c099-47b3-8568-eb4594cf5ef1";
        const key = Buffer.alloc(32, 1);
        const token = `YQ.${key.toString("base64url")}`;
        yield* fs.makeDirectory(env.path.dirname(env.backendEntryPath), { recursive: true });
        yield* fs.writeFileString(env.path.join(userdata, "environment-id"), environmentId);
        yield* fs.writeFileString(
          env.backendEntryPath,
          `
          import { appendFileSync } from "node:fs";
          const args = process.argv.slice(2);
          const home = args[args.indexOf("--base-dir") + 1];
          appendFileSync(home + "/commands", args.slice(0, 3).join(" ") + "\\n");
          if (args[2] === "issue") console.log(JSON.stringify(${JSON.stringify({ sessionId, token })}));
          else if (!args.includes("${sessionId}")) process.exit(1);
        `,
        );

        let correctHome = false;
        const server = NodeHttp.createServer(async (request, response) => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const { nonce, payload } = JSON.parse(Buffer.concat(chunks).toString());
          const address = server.address();
          if (!address || typeof address === "string" || payload !== "YQ") {
            response.writeHead(400).end();
            return;
          }
          const proof = NodeCrypto.createHmac("sha256", correctHome ? key : Buffer.alloc(32, 2))
            .update(lanDiscoveryProofMessage(nonce, environmentId, "127.0.0.1", address.port))
            .digest("base64url");
          response.end(JSON.stringify({ proof }));
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close(() => resolve());
                  server.closeAllConnections();
                }),
            ),
        );
        const address = server.address();
        assert(address !== null && typeof address !== "string");
        const legacy = { pid: process.pid, port: address.port };
        assert.isTrue(Option.isNone(yield* DesktopHomeOwner.authenticateHomeOwner(legacy)));
        const owner = { ...legacy, managedPolicy: null };
        const attach = DesktopHomeOwner.authenticateHomeOwner(owner);
        assert.isTrue(
          Option.isNone(
            yield* attach.pipe(
              Effect.provide(
                DesktopManagedPolicy.layerTest({
                  schemaVersion: 1,
                  organization: "Managed",
                }),
              ),
            ),
          ),
        );
        assert.isTrue(
          Option.isNone(
            yield* DesktopHomeOwner.authenticateHomeOwner({
              ...owner,
              managedPolicy: { organization: "Managed" },
            }),
          ),
        );
        assert.isTrue(Option.isNone(yield* attach));
        correctHome = true;
        assert.deepEqual(yield* Effect.scoped(attach), Option.some({ port: address.port, token }));
        assert.deepEqual(
          (yield* fs.readFileString(env.path.join(env.baseDir, "commands"))).trim().split("\n"),
          [
            "auth session issue",
            "auth session revoke",
            "auth session issue",
            "auth session revoke",
          ],
        );
      }).pipe(Effect.provide([DesktopManagedPolicy.layerTest(), NodeCryptoServices.layer])),
    ),
  );
});
