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

  it.effect("does not create legacy markers when claiming a new proof", () =>
    Effect.gen(function* () {
      const replayStore = yield* DpopReplayStore.DpopReplayStore;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const thumbprint = "legacy-thumbprint";
      const jti = "new-legacy-marker-jti";
      const replayKey = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${thumbprint}:${jti}`))
        .pipe(Effect.map(Encoding.encodeBase64Url));

      yield* replayStore.claim({ thumbprint, jti });

      const legacyMarker = path.join(config.secretsDir, `dpop-proof-${replayKey}.bin`);
      assert.isFalse(yield* fileSystem.exists(legacyMarker));
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

  it.effect("retains and rejects legacy markers indefinitely, including after restart", () =>
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
      if (protectedReplay._tag === "DpopReplayAlreadyClaimedError") {
        assert.equal(protectedReplay.source, "legacy");
      }

      yield* TestClock.adjust(Duration.hours(24));
      yield* replayStore.prune();
      assert.isTrue(yield* fileSystem.exists(legacyMarker));
      const laterReplay = yield* Effect.flip(replayStore.claim({ thumbprint, jti }));
      assert.equal(laterReplay._tag, "DpopReplayAlreadyClaimedError");

      const restartedStore = yield* Effect.scoped(DpopReplayStore.make);
      const restartedReplay = yield* Effect.flip(restartedStore.claim({ thumbprint, jti }));
      assert.equal(restartedReplay._tag, "DpopReplayAlreadyClaimedError");
    }).pipe(Effect.provide(makeDpopReplayStoreTestClockLayer())),
  );

  it.effect("rejects a legacy marker written just before the former startup deadline", () =>
    Effect.gen(function* () {
      const replayStore = yield* DpopReplayStore.DpopReplayStore;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const input = { thumbprint: "legacy-thumbprint", jti: "late-legacy-jti" };
      const replayKey = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${input.thumbprint}:${input.jti}`))
        .pipe(Effect.map(Encoding.encodeBase64Url));

      yield* TestClock.adjust(Duration.seconds(359));
      yield* fileSystem.writeFile(
        path.join(config.secretsDir, `dpop-proof-${replayKey}.bin`),
        new Uint8Array(),
      );
      yield* TestClock.adjust(Duration.seconds(2));
      const error = yield* Effect.flip(replayStore.claim(input));
      assert.equal(error._tag, "DpopReplayAlreadyClaimedError");
      if (error._tag === "DpopReplayAlreadyClaimedError") {
        assert.equal(error.source, "legacy");
      }
    }).pipe(Effect.provide(makeDpopReplayStoreTestClockLayer())),
  );

  it.effect("does not prune a fresh legacy marker written long after startup", () =>
    Effect.gen(function* () {
      const replayStore = yield* DpopReplayStore.DpopReplayStore;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const input = { thumbprint: "legacy-thumbprint", jti: "fresh-legacy-jti" };
      const replayKey = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${input.thumbprint}:${input.jti}`))
        .pipe(Effect.map(Encoding.encodeBase64Url));
      const legacyMarker = path.join(config.secretsDir, `dpop-proof-${replayKey}.bin`);

      yield* TestClock.adjust(Duration.hours(1));
      yield* fileSystem.writeFile(legacyMarker, new Uint8Array([42]));
      yield* replayStore.prune();
      assert.deepEqual(yield* fileSystem.readFile(legacyMarker), new Uint8Array([42]));
      const error = yield* Effect.flip(replayStore.claim(input));
      assert.equal(error._tag, "DpopReplayAlreadyClaimedError");
    }).pipe(Effect.provide(makeDpopReplayStoreTestClockLayer())),
  );

  it.effect("allows only one concurrent claim across independent stores sharing secrets", () =>
    Effect.gen(function* () {
      const firstStore = yield* DpopReplayStore.DpopReplayStore;
      const secondStore = yield* Effect.scoped(DpopReplayStore.make);
      const input = { thumbprint: "shared-thumbprint", jti: "concurrent-jti" };
      const outcomes = yield* Effect.all(
        [firstStore, secondStore].map((store) =>
          store.claim(input).pipe(
            Effect.match({
              onSuccess: () => "claimed",
              onFailure: (error) => error._tag,
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      assert.sameMembers(outcomes, ["claimed", "DpopReplayAlreadyClaimedError"]);
    }).pipe(Effect.provide(makeDpopReplayStoreLayer())),
  );

  it.effect("fails closed when reading a legacy marker returns an unexpected stat error", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* Effect.scoped(
        DpopReplayStore.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            stat: (path) =>
              String(path).includes("dpop-proof-")
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "stat",
                      pathOrDescriptor: String(path),
                      description: "Injected legacy marker stat failure.",
                    }),
                  )
                : fileSystem.stat(path),
          }),
        ),
      );
      const error = yield* Effect.flip(
        store.claim({ thumbprint: "thumbprint", jti: "stat-failure-jti" }),
      );
      assert.equal(error._tag, "DpopReplayStoreClaimError");
    }).pipe(Effect.provide(makeDpopReplayStoreLayer())),
  );
});
