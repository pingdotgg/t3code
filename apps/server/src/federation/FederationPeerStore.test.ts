import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as FederationPeerStore from "./FederationPeerStore.ts";

const epochMs = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

/**
 * Runs `body` against a fresh state directory. Every `FederationPeerStore.make`
 * inside it is a new store instance over the same files, which is exactly what
 * a server restart looks like to the store.
 */
const withStateDir = <A, E>(
  body: Effect.Effect<A, E, ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-federation-store-" });
    return yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      return yield* body;
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("FederationPeerStore pending peer codes", () => {
  it.effect("offered codes survive a restart and settle on redemption or expiry", () =>
    withStateDir(
      Effect.gen(function* () {
        const before = yield* FederationPeerStore.make;
        yield* before.addPendingPeerCode({
          linkId: "link-redeemed",
          scopes: ["projects.read", "runs.start"],
          expiresAt: "2026-09-04T00:10:00.000Z",
        });
        yield* before.addPendingPeerCode({
          linkId: "link-expired",
          scopes: ["environment.read"],
          expiresAt: "2026-09-04T00:00:30.000Z",
        });
        yield* before.addPendingPeerCode({
          linkId: "link-live",
          scopes: ["runs.read"],
          expiresAt: "2026-09-04T00:10:00.000Z",
        });

        const restarted = yield* FederationPeerStore.make;
        assert.deepEqual(
          (yield* restarted.pendingPeerCodes).map((code) => code.linkId),
          ["link-redeemed", "link-expired", "link-live"],
        );

        yield* restarted.settlePendingPeerCodes({
          redeemedLinkId: "link-redeemed",
          nowMs: epochMs("2026-09-04T00:01:00.000Z"),
        });
        assert.deepEqual(yield* restarted.pendingPeerCodes, [
          { linkId: "link-live", scopes: ["runs.read"], expiresAt: "2026-09-04T00:10:00.000Z" },
        ]);

        const again = yield* FederationPeerStore.make;
        assert.deepEqual(
          (yield* again.pendingPeerCodes).map((code) => code.linkId),
          ["link-live"],
        );
      }),
    ),
  );

  it.effect("state files written before pending codes existed still load", () =>
    withStateDir(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        yield* fs.writeFileString(
          path.join(config.stateDir, FederationPeerStore.FEDERATION_STATE_FILE),
          `{"version":1,"peers":[],"remoteRuns":[],"inboundRuns":[{"threadId":"thread-1","peerId":"environment-test","createdAt":"2026-09-03T00:00:00.000Z"}]}`,
        );

        const store = yield* FederationPeerStore.make;
        assert.deepEqual(yield* store.pendingPeerCodes, []);
        assert.deepEqual(
          (yield* store.inboundRuns).map((run) => run.threadId),
          [ThreadId.make("thread-1")],
        );
      }),
    ),
  );
});
