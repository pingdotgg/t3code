// @effect-diagnostics nodeBuiltinImport:off - customer authentication over a loopback fixture.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Account from "./KiloCloudAccount.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.live("separates credential rejection, account support and temporary profile failures", () =>
  Effect.gen(function* () {
    let responseStatus = 503;
    let personal = true;
    let requests = 0;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-account-" });
    yield* fs.makeDirectory(`${root}/data/kilo`, { recursive: true });
    const write = (key: string) =>
      fs.writeFileString(`${root}/data/kilo/auth.json`, encode({ kilo: { type: "api", key } }));
    yield* write("synthetic-a");
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = NodeHttp.createServer((req, res) => {
          requests += 1;
          res.writeHead(responseStatus, { "content-type": "application/json" });
          res.end(
            encode({
              user: { id: req.headers.authorization === "Bearer synthetic-a" ? "a" : "b" },
              hasPersonalAccount: personal,
            }),
          );
        });
        server.listen(0, "127.0.0.1");
        await NodeEvents.EventEmitter.once(server, "listening");
        return server;
      }),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    );
    const address = server.address();
    if (!address || typeof address === "string") return yield* Effect.die("No fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const identityPath = `${root}/state/account.json`;
    const account = yield* Account.make(root, origin, identityPath);
    assert.equal((yield* account.load.pipe(Effect.flip)).reason, "invalid_response");
    responseStatus = 401;
    assert.equal((yield* account.load.pipe(Effect.flip)).reason, "rejected");
    responseStatus = 200;
    personal = false;
    assert.equal((yield* account.load.pipe(Effect.flip)).reason, "unsupported");
    personal = true;
    assert.equal((yield* account.load).accountId, "a");
    const savedIdentity = yield* fs.readFileString(identityPath);
    assert.isFalse(savedIdentity.includes("synthetic-a"));
    responseStatus = 503;
    const restarted = yield* Account.make(root, origin, identityPath);
    const requestCount = requests;
    const restored = yield* restarted.restore;
    assert.equal(restored.accountId, "a");
    assert.isFalse(restored.verified);
    assert.equal(requests, requestCount);
    assert.equal((yield* restarted.load.pipe(Effect.flip)).reason, "invalid_response");
    responseStatus = 401;
    assert.equal((yield* restarted.load.pipe(Effect.flip)).reason, "rejected");
    responseStatus = 200;
    assert.equal((yield* restarted.load).accountId, "a");
    yield* write("synthetic-b");
    responseStatus = 503;
    assert.equal((yield* restarted.restore.pipe(Effect.flip)).reason, "invalid_response");
    responseStatus = 200;
    assert.equal((yield* account.load).accountId, "b");
    yield* fs.writeFileString(`${root}/data/kilo/auth.json`, "malformed");
    assert.equal((yield* account.load.pipe(Effect.flip)).reason, "rejected");
    assert.equal((yield* restarted.restore.pipe(Effect.flip)).reason, "rejected");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
