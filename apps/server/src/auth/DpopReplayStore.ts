import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const REPLAY_BUCKET_DURATION = Duration.minutes(10);
const REPLAY_BUCKET_MILLISECONDS = Duration.toMillis(REPLAY_BUCKET_DURATION);
const LEGACY_REPLAY_RETENTION = Duration.minutes(6);
const REPLAY_DIRECTORY_NAME = "dpop-replay";
const replayBucketPattern = /^(0|[1-9][0-9]*)$/;
const legacyReplayMarkerPattern = /^dpop-proof-[A-Za-z0-9_-]{43}\.bin$/;

const dpopReplayStoreSetupStage = Schema.Literals(["make-directory", "set-permissions"]);
const dpopReplayStoreClaimStage = Schema.Literals([
  "ensure-bucket",
  "legacy-lookup",
  "write-marker",
]);
const dpopReplayStorePruneStage = Schema.Literals([
  "read-buckets",
  "remove-bucket",
  "read-legacy",
  "remove-legacy",
]);

export class DpopReplayStoreSetupError extends Schema.TaggedErrorClass<DpopReplayStoreSetupError>()(
  "DpopReplayStoreSetupError",
  {
    cause: Schema.Defect(),
    stage: dpopReplayStoreSetupStage,
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to ${this.stage} for DPoP replay storage at ${this.resource}.`;
  }
}

export class DpopReplayStoreKeyCalculationError extends Schema.TaggedErrorClass<DpopReplayStoreKeyCalculationError>()(
  "DpopReplayStoreKeyCalculationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to calculate DPoP replay key.";
  }
}

export class DpopReplayStoreClaimError extends Schema.TaggedErrorClass<DpopReplayStoreClaimError>()(
  "DpopReplayStoreClaimError",
  {
    cause: Schema.Defect(),
    stage: dpopReplayStoreClaimStage,
    resource: Schema.String,
    bucket: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return `Failed to ${this.stage} for DPoP replay state at ${this.resource}.`;
  }
}

export class DpopReplayAlreadyClaimedError extends Schema.TaggedErrorClass<DpopReplayAlreadyClaimedError>()(
  "DpopReplayAlreadyClaimedError",
  {
    source: Schema.Literals(["bucket", "legacy"]),
    markerPath: Schema.String,
    bucket: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return `DPoP replay marker already exists at ${this.markerPath}.`;
  }
}
export const isDpopReplayAlreadyClaimedError = Schema.is(DpopReplayAlreadyClaimedError);

export class DpopReplayStorePruneError extends Schema.TaggedErrorClass<DpopReplayStorePruneError>()(
  "DpopReplayStorePruneError",
  {
    cause: Schema.Defect(),
    stage: dpopReplayStorePruneStage,
    resource: Schema.String,
    bucket: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return `Failed to ${this.stage} for DPoP replay state at ${this.resource}.`;
  }
}

export const DpopReplayStoreError = Schema.Union([
  DpopReplayStoreSetupError,
  DpopReplayStoreKeyCalculationError,
  DpopReplayAlreadyClaimedError,
  DpopReplayStoreClaimError,
  DpopReplayStorePruneError,
]);
export type DpopReplayStoreError = typeof DpopReplayStoreError.Type;
export const isDpopReplayStoreError = Schema.is(DpopReplayStoreError);

export class DpopReplayStore extends Context.Service<
  DpopReplayStore,
  {
    readonly claim: (input: {
      readonly thumbprint: string;
      readonly jti: string;
    }) => Effect.Effect<
      void,
      DpopReplayStoreKeyCalculationError | DpopReplayAlreadyClaimedError | DpopReplayStoreClaimError
    >;
    readonly prune: () => Effect.Effect<void, DpopReplayStorePruneError>;
  }
>()("t3/auth/DpopReplayStore") {}

const bucketFor = (now: DateTime.DateTime) =>
  Math.floor(now.epochMilliseconds / REPLAY_BUCKET_MILLISECONDS);

const isBucketDirectory = (entry: string) => replayBucketPattern.test(entry);

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const replayDirectory = path.join(config.secretsDir, REPLAY_DIRECTORY_NAME);
  const legacyProtectionEndsAt = DateTime.add(yield* DateTime.now, {
    milliseconds: Duration.toMillis(LEGACY_REPLAY_RETENTION),
  });

  yield* fileSystem.makeDirectory(replayDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DpopReplayStoreSetupError({
          cause,
          stage: "make-directory",
          resource: replayDirectory,
        }),
    ),
  );
  yield* fileSystem.chmod(replayDirectory, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new DpopReplayStoreSetupError({
          cause,
          stage: "set-permissions",
          resource: replayDirectory,
        }),
    ),
  );

  const ensureBucketDirectory = (bucket: number) => {
    const directory = path.join(replayDirectory, String(bucket));
    return Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.chmod(directory, 0o700);
      return directory;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DpopReplayStoreClaimError({
            cause,
            stage: "ensure-bucket",
            resource: directory,
            bucket,
          }),
      ),
    );
  };

  const legacyMarkerExists = (replayKey: string) => {
    const markerPath = path.join(config.secretsDir, `dpop-proof-${replayKey}.bin`);
    return fileSystem.stat(markerPath).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(false)
          : Effect.fail(
              new DpopReplayStoreClaimError({
                cause,
                stage: "legacy-lookup",
                resource: markerPath,
              }),
            ),
      ),
      Effect.flatMap((exists) =>
        exists
          ? Effect.fail(
              new DpopReplayAlreadyClaimedError({
                source: "legacy",
                markerPath,
              }),
            )
          : Effect.void,
      ),
    );
  };

  const pruneLegacy = Effect.fn("DpopReplayStore.pruneLegacy")(function* () {
    const entries = yield* fileSystem.readDirectory(config.secretsDir, { recursive: false }).pipe(
      Effect.mapError(
        (cause) =>
          new DpopReplayStorePruneError({
            cause,
            stage: "read-legacy",
            resource: config.secretsDir,
          }),
      ),
    );
    yield* Effect.forEach(
      entries,
      (entry) =>
        legacyReplayMarkerPattern.test(entry)
          ? fileSystem.remove(path.join(config.secretsDir, entry), { force: true }).pipe(
              Effect.mapError(
                (cause) =>
                  new DpopReplayStorePruneError({
                    cause,
                    stage: "remove-legacy",
                    resource: path.join(config.secretsDir, entry),
                  }),
              ),
            )
          : Effect.void,
      { concurrency: 1 },
    );
  });

  const prune: DpopReplayStore["Service"]["prune"] = Effect.fn("DpopReplayStore.prune")(
    function* () {
      const now = yield* DateTime.now;
      const currentBucket = bucketFor(now);
      const entries = yield* fileSystem.readDirectory(replayDirectory, { recursive: false }).pipe(
        Effect.mapError(
          (cause) =>
            new DpopReplayStorePruneError({
              cause,
              stage: "read-buckets",
              resource: replayDirectory,
            }),
        ),
      );

      yield* Effect.forEach(
        entries,
        (entry) => {
          if (!isBucketDirectory(entry)) {
            return Effect.void;
          }
          const bucket = Number(entry);
          if (!Number.isSafeInteger(bucket) || bucket >= currentBucket) {
            return Effect.void;
          }
          const bucketPath = path.join(replayDirectory, entry);
          return fileSystem.remove(bucketPath, { recursive: true, force: true }).pipe(
            Effect.mapError(
              (cause) =>
                new DpopReplayStorePruneError({
                  cause,
                  stage: "remove-bucket",
                  resource: bucketPath,
                  bucket,
                }),
            ),
          );
        },
        { concurrency: 1 },
      );

      if (!DateTime.isLessThan(now, legacyProtectionEndsAt)) {
        yield* pruneLegacy();
      }
    },
  );

  const claim: DpopReplayStore["Service"]["claim"] = Effect.fn("DpopReplayStore.claim")(function* ({
    thumbprint,
    jti,
  }) {
    const replayKey = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`${thumbprint}:${jti}`))
      .pipe(
        Effect.map(Encoding.encodeBase64Url),
        Effect.mapError((cause) => new DpopReplayStoreKeyCalculationError({ cause })),
      );
    const now = yield* DateTime.now;
    const currentBucket = bucketFor(now);

    if (DateTime.isLessThan(now, legacyProtectionEndsAt)) {
      yield* legacyMarkerExists(replayKey);
    }

    // Claim the future bucket first so a partial failure leaves a marker that
    // cannot be pruned while the proof is still inside its acceptance window.
    for (const bucket of [currentBucket + 1, currentBucket]) {
      const directory = yield* ensureBucketDirectory(bucket);
      const markerPath = path.join(directory, replayKey);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* fileSystem.open(markerPath, {
            flag: "wx",
            mode: 0o600,
          });
          yield* marker.sync;
        }),
      ).pipe(
        Effect.mapError((cause) =>
          cause.reason._tag === "AlreadyExists"
            ? new DpopReplayAlreadyClaimedError({
                source: "bucket",
                markerPath,
                bucket,
              })
            : new DpopReplayStoreClaimError({
                cause,
                stage: "write-marker",
                resource: markerPath,
                bucket,
              }),
        ),
      );
    }
  });

  yield* prune().pipe(
    Effect.catch((cause) => Effect.logWarning("Failed to prune DPoP replay state.", { cause })),
    Effect.repeat(Schedule.spaced(REPLAY_BUCKET_DURATION)),
    Effect.forkScoped,
  );

  return DpopReplayStore.of({ claim, prune });
});

export const layer = Layer.effect(DpopReplayStore, make);
