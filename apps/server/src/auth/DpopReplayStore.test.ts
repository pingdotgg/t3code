import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as DpopReplayStore from "./DpopReplayStore.ts";

const makeDpopReplayStoreLayer = () =>
  DpopReplayStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dpop-replay-test-" })),
  );

const makeDpopReplayStoreTestClockLayer = () =>
  DpopReplayStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dpop-replay-test-" })),
    Layer.provideMerge(TestClock.layer()),
  );

const replayDirectory = (secretsDir: string, path: Path.Path) =>
  path.join(secretsDir, "dpop-replay");

const SecondMarkerOpenFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const markerOpenCount = yield* Ref.make(0);

    return {
      ...fileSystem,
      open: (path, options) =>
        String(path).includes("/dpop-replay/") && options?.flag === "wx"
          ? Ref.updateAndGet(markerOpenCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 2
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "open",
                        pathOrDescriptor: String(path),
                        description: "Injected current-bucket marker failure.",
                      }),
                    )
                  : fileSystem.open(path, options),
              ),
            )
          : fileSystem.open(path, options),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeSecondMarkerOpenFailureStoreLayer = () =>
  DpopReplayStore.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-dpop-replay-failure-test-" }),
    ),
    Layer.provide(SecondMarkerOpenFailureFileSystemLayer),
    Layer.provideMerge(TestClock.layer()),
  );

it.layer(NodeServices.layer)("DpopReplayStore.layer", (it) => {
  it.effect("uses empty fixed-name markers in the current and next buckets", () =>
    Effect.gen(function* () {
      const replayStore = yield* DpopReplayStore.DpopReplayStore;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      yield* replayStore.claim({ thumbprint: "thumbprint", jti: "marker-jti" });

      const bucket = String(Math.floor((yield* DateTime.now).epochMilliseconds / 600_000));
      const entries = yield* fileSystem.readDirectory(
        path.join(replayDirectory(config.secretsDir, path), bucket),
      );

      assert.equal(entries.length, 1);
      assert.notInclude(entries[0]!, "marker-jti");
      const marker = yield* fileSystem.readFile(
        path.join(replayDirectory(config.secretsDir, path), bucket, entries[0]!),
      );
      assert.equal(marker.byteLength, 0);
    }).pipe(Effect.provide(makeDpopReplayStoreLayer())),
  );

  it.effect("keeps current and next buckets while pruning stale buckets", () =>
    Effect.gen(function* () {
      const replayStore = yield* DpopReplayStore.DpopReplayStore;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const root = replayDirectory(config.secretsDir, path);

      yield* TestClock.adjust(Duration.minutes(10));
      yield* replayStore.claim({ thumbprint: "thumbprint", jti: "current-jti" });
      yield* fileSystem.makeDirectory(path.join(root, "0"), { recursive: true });
      yield* fileSystem.writeFile(path.join(root, "0", "stale-marker"), new Uint8Array());

      yield* replayStore.prune();

      const entries = yield* fileSystem.readDirectory(root);
      assert.notInclude(entries, "0");
      assert.include(entries, "1");
      assert.include(entries, "2");
    }).pipe(Effect.provide(makeDpopReplayStoreTestClockLayer())),
  );

  it.effect("rejects a jti replayed across a bucket boundary", () =>
    Effect.gen(function* () {
      const replayStore = yield* DpopReplayStore.DpopReplayStore;

      yield* TestClock.adjust(Duration.seconds(599));
      yield* replayStore.claim({ thumbprint: "thumbprint", jti: "boundary-jti" });
      yield* TestClock.adjust(Duration.seconds(2));
      const error = yield* Effect.flip(
        replayStore.claim({ thumbprint: "thumbprint", jti: "boundary-jti" }),
      );

      assert.equal(error._tag, "DpopReplayAlreadyClaimedError");
      assert.isTrue(DpopReplayStore.isDpopReplayAlreadyClaimedError(error));
    }).pipe(Effect.provide(makeDpopReplayStoreTestClockLayer())),
  );

  it.effect("keeps a future marker when the current-bucket claim fails", () =>
    Effect.gen(function* () {
      const replayStore = yield* DpopReplayStore.DpopReplayStore;

      yield* TestClock.adjust(Duration.seconds(599));
      const partialClaim = yield* Effect.flip(
        replayStore.claim({ thumbprint: "thumbprint", jti: "partial-claim-jti" }),
      );
      assert.equal(partialClaim._tag, "DpopReplayStoreClaimError");
      assert.isFalse(DpopReplayStore.isDpopReplayAlreadyClaimedError(partialClaim));

      yield* TestClock.adjust(Duration.seconds(2));
      const replay = yield* Effect.flip(
        replayStore.claim({ thumbprint: "thumbprint", jti: "partial-claim-jti" }),
      );
      assert.isTrue(DpopReplayStore.isDpopReplayAlreadyClaimedError(replay));
    }).pipe(Effect.provide(makeSecondMarkerOpenFailureStoreLayer())),
  );

  it.effect("honors legacy markers until their replay window expires", () =>
    Effect.gen(function* () {
      const replayStore = yield* DpopReplayStore.DpopReplayStore;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const thumbprint = "legacy-thumbprint";
      const jti = "legacy-jti";
      const replayKey = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${thumbprint}:${jti}`))
        .pipe(Effect.map(Encoding.encodeBase64Url));
      const legacyMarker = path.join(config.secretsDir, `dpop-proof-${replayKey}.bin`);
      yield* fileSystem.writeFile(legacyMarker, new Uint8Array());

      const protectedReplay = yield* Effect.flip(replayStore.claim({ thumbprint, jti }));
      assert.isTrue(DpopReplayStore.isDpopReplayAlreadyClaimedError(protectedReplay));

      yield* TestClock.adjust(Duration.minutes(6));
      yield* replayStore.prune();
      const remainingSecrets = yield* fileSystem.readDirectory(config.secretsDir);
      assert.notInclude(remainingSecrets, path.basename(legacyMarker));
      yield* replayStore.claim({ thumbprint, jti });
    }).pipe(Effect.provide(makeDpopReplayStoreTestClockLayer())),
  );
});
