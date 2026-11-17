import * as s3 from "@distilled.cloud/aws/s3";
import { decodeFqn, encodeFqn } from "alchemy/FQN";
import { encodeState, reviveState } from "alchemy/State/StateEncoding";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * The S3 state store's object layout, read and written directly: what the
 * DynamoDB store checks for a stage that hasn't moved yet, and what
 * `alchemy state migrate` copies from (and, rolling back, to).
 *
 * ```
 * s3://{bucket}/{prefix}{stack}/{stage}/{fqn}.json
 * s3://{bucket}/{prefix}{stack}/{stage}/__stack_output__.json
 * s3://{bucket}/{prefix}{stack}/{stage}/__lease__.json
 * ```
 */

/** Where an S3 state store keeps its objects. */
export interface LegacyLocation {
  readonly bucket: string;
  /** Normalized: empty, or ending in `/`. */
  readonly prefix: string;
}

const OUTPUT_FILE = "__stack_output__.json";
const LEASE_FILE = "__lease__.json";

/**
 * The token of the lease a migrated stage keeps forever. Every S3 store
 * since 2.0.0-beta.84 reads a lease that expires in the future as held by
 * another deploy. Earlier versions take no lease; the bucket policy
 * {@link setStageAccess} writes stops those.
 */
export const FENCE_TOKEN = "migrated:dynamodb";

/** How a state store's error says another deploy holds a stage's lease. */
export const HELD_PREFIX = "another deploy holds";

/** Whether a state store failed because another deploy holds the stage. */
export const isLeaseHeld = (error: { readonly message: string }) =>
  error.message.startsWith(HELD_PREFIX);

/** Maximum number of keys S3 accepts in one DeleteObjects call. */
const DELETE_BATCH_SIZE = 1000;

/** An S3 store object that can't be read, or a lease that can't be taken. */
export class LegacyStateError extends Data.TaggedError("LegacyStateError")<{
  readonly message: string;
}> {}

class EmptyBody extends Data.TaggedError("EmptyBody") {}

export const normalizePrefix = (prefix: string | undefined) =>
  prefix ? `${prefix.replace(/\/+$/, "")}/` : "";

const stagePrefix = (location: LegacyLocation, stack: string, stage: string) =>
  `${location.prefix}${stack}/${stage}/`;

const recordKey = (location: LegacyLocation, stack: string, stage: string, fqn: string) =>
  `${stagePrefix(location, stack, stage)}${encodeFqn(fqn)}.json`;

/** The JSON text of an object, or `undefined` when it or its bucket is missing. */
const readText = (bucket: string, key: string) =>
  s3.getObject({ Bucket: bucket, Key: key }).pipe(
    Effect.flatMap((result) =>
      result.Body === undefined
        ? Effect.undefined
        : result.Body.pipe(
            Stream.decodeText,
            Stream.mkString,
            Effect.map((text) => ({ text, etag: result.ETag })),
          ),
    ),
    Effect.catchTag(["NoSuchKey", "NoSuchBucket"], () => Effect.undefined),
  );

/** Every key under `prefix`, across pagination. A missing bucket has none. */
const listKeys = (bucket: string, prefix: string) =>
  s3.listObjectsV2.pages({ Bucket: bucket, Prefix: prefix }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.Contents ?? [])),
    Stream.map((object) => object.Key),
    Stream.filter((key): key is string => key !== undefined),
    Stream.runCollect,
    Effect.map((keys) => Array.from(keys)),
    Effect.catchTag("NoSuchBucket", () => Effect.succeed<string[]>([])),
  );

/** The "directory" names directly under `prefix`. A missing bucket has none. */
const listChildren = (bucket: string, prefix: string) =>
  s3.listObjectsV2.pages({ Bucket: bucket, Prefix: prefix, Delimiter: "/" }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.CommonPrefixes ?? [])),
    Stream.map((common) => common.Prefix),
    Stream.filter((p): p is string => p !== undefined),
    Stream.map((p) => p.slice(prefix.length, -1)),
    Stream.runCollect,
    Effect.map((names) => Array.from(names)),
    Effect.catchTag("NoSuchBucket", () => Effect.succeed<string[]>([])),
  );

/** Whether the S3 store has any object, a lease included, for the stage. */
export const hasLegacyStage = (location: LegacyLocation, stack: string, stage: string) =>
  s3
    .listObjectsV2({
      Bucket: location.bucket,
      Prefix: stagePrefix(location, stack, stage),
      MaxKeys: 1,
    })
    .pipe(
      Effect.map((result) => (result.Contents?.length ?? 0) > 0),
      Effect.catchTag("NoSuchBucket", () => Effect.succeed(false)),
    );

export const listLegacyStacks = (location: LegacyLocation) =>
  listChildren(location.bucket, location.prefix);

export const listLegacyStages = (location: LegacyLocation, stack: string) =>
  listChildren(location.bucket, `${location.prefix}${stack}/`);

const parse = (text: string, key: string) =>
  Effect.try({
    try: () => JSON.parse(text, reviveState) as unknown,
    catch: (cause) =>
      new LegacyStateError({
        message: `Failed to parse S3 state object '${key}': ${String(cause)}`,
      }),
  });

/** The stage's output, read without the S3 store's lease. */
export const readLegacyOutput = (location: LegacyLocation, stack: string, stage: string) => {
  const key = `${stagePrefix(location, stack, stage)}${OUTPUT_FILE}`;
  return readText(location.bucket, key).pipe(
    Effect.flatMap((object) => (object === undefined ? Effect.undefined : parse(object.text, key))),
  );
};

/** A stage's contents, each value encoded the way the DynamoDB store stores it. */
export interface StageContents {
  /** Encoded state by FQN. */
  readonly records: ReadonlyMap<string, string>;
  readonly output: string | undefined;
}

/** Re-encode stored JSON into the DynamoDB store's canonical form. */
const canonical = (text: string, key: string) =>
  parse(text, key).pipe(Effect.map((value) => JSON.stringify(encodeState(value))));

/** Read every record and the output of a stage. */
export const readLegacyStage = Effect.fn(function* (
  location: LegacyLocation,
  stack: string,
  stage: string,
) {
  const prefix = stagePrefix(location, stack, stage);
  const keys = yield* listKeys(location.bucket, prefix);
  const recordKeys = keys.filter((key) => {
    const file = key.slice(prefix.length);
    return file !== OUTPUT_FILE && file !== LEASE_FILE && file.endsWith(".json");
  });
  const records = yield* Effect.forEach(
    recordKeys,
    (key) =>
      Effect.gen(function* () {
        const result = yield* s3.getObject({ Bucket: location.bucket, Key: key });
        if (result.Body === undefined) return yield* new EmptyBody();
        return yield* result.Body.pipe(
          Stream.decodeText,
          Stream.mkString,
          Effect.mapError(
            (cause) =>
              new LegacyStateError({
                message: `Failed to read S3 state object '${key}': ${cause}`,
              }),
          ),
        );
      }).pipe(
        // A response without its body is a transport hiccup, and a key
        // just listed can briefly read as missing: read again. Deletes are
        // denied while the stage is fenced, so a key that stays missing
        // was deleted by something the fence doesn't stop.
        Effect.retry({
          while: (error) => error._tag === "EmptyBody" || error._tag === "NoSuchKey",
          schedule: Schedule.spaced("1 second"),
          times: 4,
        }),
        Effect.catchTags({
          EmptyBody: () =>
            Effect.fail(new LegacyStateError({ message: `S3 state object '${key}' has no body` })),
          // Listed but gone: something is writing the stage. Copying the
          // rest would leave a resource untracked.
          NoSuchKey: (error) =>
            Effect.fail(
              new LegacyStateError({
                message: `S3 state object '${key}' was deleted while '${stack}/${stage}' was being read; another deploy is writing it (${error.message ?? "NoSuchKey"})`,
              }),
            ),
        }),
        Effect.flatMap((text) =>
          canonical(text, key).pipe(
            Effect.map((canonicalText) => [
              [decodeFqn(key.slice(prefix.length).replace(/\.json$/, "")), canonicalText] as const,
            ]),
          ),
        ),
      ),
    { concurrency: 16 },
  );
  const outputKey = `${prefix}${OUTPUT_FILE}`;
  const output = keys.includes(outputKey)
    ? yield* readText(location.bucket, outputKey).pipe(
        Effect.flatMap((object) =>
          object === undefined ? Effect.undefined : canonical(object.text, outputKey),
        ),
      )
    : undefined;
  return { records: new Map(records.flat()), output } satisfies StageContents;
});

/**
 * Write a stage back in the S3 store's layout, deleting records it no longer
 * has. The stage must be fenced, so no S3 store writes it meanwhile.
 */
export const writeLegacyStage = Effect.fn(function* (
  location: LegacyLocation,
  stack: string,
  stage: string,
  contents: StageContents,
) {
  const prefix = stagePrefix(location, stack, stage);
  const pretty = (text: string) => JSON.stringify(JSON.parse(text), null, 2);
  yield* Effect.forEach(
    Array.from(contents.records),
    ([fqn, text]) =>
      s3.putObject({
        Bucket: location.bucket,
        Key: recordKey(location, stack, stage, fqn),
        Body: pretty(text),
        ContentType: "application/json",
      }),
    { concurrency: 16, discard: true },
  );
  const outputKey = `${prefix}${OUTPUT_FILE}`;
  if (contents.output !== undefined) {
    yield* s3.putObject({
      Bucket: location.bucket,
      Key: outputKey,
      Body: pretty(contents.output),
      ContentType: "application/json",
    });
  }
  const keep = new Set([
    `${prefix}${LEASE_FILE}`,
    ...(contents.output === undefined ? [] : [outputKey]),
    ...Array.from(contents.records.keys(), (fqn) => recordKey(location, stack, stage, fqn)),
  ]);
  const stale = (yield* listKeys(location.bucket, prefix)).filter((key) => !keep.has(key));
  yield* Effect.forEach(
    Arr.chunksOf(stale, DELETE_BATCH_SIZE),
    (batch) =>
      s3.deleteObjects({
        Bucket: location.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    { discard: true },
  );
});

const parseLease = (text: string) => {
  try {
    const parsed = JSON.parse(text) as { token?: unknown; expiresAt?: unknown };
    return {
      token: typeof parsed.token === "string" ? parsed.token : "",
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
    };
  } catch {
    return { token: "", expiresAt: 0 };
  }
};

export type FenceResult =
  /** The stage is fenced: this call fenced it, or an earlier migration did. */
  | { readonly fenced: true }
  /** An S3 store holds the stage's lease. */
  | { readonly fenced: false; readonly expiresAt: number };

/**
 * Take the stage's S3 lease for good: write a lease that never expires, with
 * the same conditional puts the S3 store uses, so a deploy holding the lease
 * keeps it and a lapsed one is replaced.
 */
export const fenceLegacyStage = (
  location: LegacyLocation,
  stack: string,
  stage: string,
  table: string,
) => {
  const key = `${stagePrefix(location, stack, stage)}${LEASE_FILE}`;
  const body = JSON.stringify({
    token: FENCE_TOKEN,
    expiresAt: Number.MAX_SAFE_INTEGER,
    migratedTo: `dynamodb:${table}`,
  });
  // `undefined` when a conditional put lost to another writer.
  const attempt = Effect.gen(function* () {
    const existing = yield* readText(location.bucket, key);
    if (existing !== undefined) {
      const lease = parseLease(existing.text);
      if (lease.token === FENCE_TOKEN) return { fenced: true } as FenceResult;
      if (lease.expiresAt > (yield* Clock.currentTimeMillis)) {
        return { fenced: false, expiresAt: lease.expiresAt } as FenceResult;
      }
    }
    return yield* s3
      .putObject({
        Bucket: location.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ...(existing === undefined ? { IfNoneMatch: "*" } : { IfMatch: existing.etag }),
      })
      .pipe(
        Effect.as<FenceResult | undefined>({ fenced: true }),
        Effect.catchTag(
          ["PreconditionFailed", "ConditionalRequestConflict"],
          () => Effect.undefined,
        ),
        // No S3 store has ever written here: there is nothing to fence.
        Effect.catchTag("NoSuchBucket", () => Effect.succeed<FenceResult>({ fenced: true })),
      );
  });
  // A lost condition means another writer got there first: look again.
  return attempt.pipe(
    Effect.repeat({ until: (result) => result !== undefined, times: 4 }),
    Effect.flatMap((result) =>
      result === undefined
        ? Effect.fail(
            new LegacyStateError({
              message: `Could not fence S3 state stage '${stack}/${stage}': its lease kept changing`,
            }),
          )
        : Effect.succeed(result),
    ),
  );
};

/** Remove the stage's fence, so S3 stores can take its lease again. */
export const unfenceLegacyStage = (location: LegacyLocation, stack: string, stage: string) => {
  const key = `${stagePrefix(location, stack, stage)}${LEASE_FILE}`;
  return readText(location.bucket, key).pipe(
    Effect.flatMap((existing) =>
      existing === undefined || parseLease(existing.text).token !== FENCE_TOKEN
        ? Effect.void
        : s3
            .deleteObject({ Bucket: location.bucket, Key: key, IfMatch: existing.etag })
            .pipe(Effect.asVoid),
    ),
  );
};

/**
 * What the bucket policy lets every principal do with a stage's objects:
 *
 * - `open`: what IAM allows.
 * - `fenced`: no writes or deletes, while the stage is copied.
 * - `migrated`: no reads, writes or deletes. A version of alchemy that takes
 *   no lease fails at its first read, before it deploys anything.
 */
export type StageAccess = "open" | "fenced" | "migrated";

const FENCED_SID = "AlchemyStateFenced";
const MIGRATED_SID = "AlchemyStateMigrated";
const DENIED_ACTIONS = {
  [FENCED_SID]: ["s3:PutObject", "s3:DeleteObject"],
  [MIGRATED_SID]: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
} as const;

/** S3's limit on the size of a bucket policy. */
const MAX_POLICY_BYTES = 20 * 1024;

interface PolicyStatement {
  readonly Sid?: string;
  readonly Resource?: string | ReadonlyArray<string>;
  readonly [key: string]: unknown;
}

const asArray = <T>(value: T | ReadonlyArray<T> | undefined): ReadonlyArray<T> =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as T];

/** The bucket's policy statements; none when it has no policy or no bucket. */
const readPolicy = (bucket: string) =>
  s3.getBucketPolicy({ Bucket: bucket }).pipe(
    Effect.map((result) => result.Policy),
    Effect.catchTag(["NoSuchBucketPolicy", "NoSuchBucket"], () => Effect.undefined),
    Effect.flatMap((text) =>
      Effect.try({
        try: () =>
          (text === undefined ? {} : JSON.parse(text)) as {
            Version?: string;
            Statement?: PolicyStatement | ReadonlyArray<PolicyStatement>;
          },
        catch: () =>
          new LegacyStateError({ message: `The bucket policy of '${bucket}' is not valid JSON` }),
      }),
    ),
    Effect.map((policy) => ({
      version: policy.Version ?? "2012-10-17",
      statements: asArray(policy.Statement),
    })),
  );

// Policy edits are read-modify-write; one at a time per process.
const policyLock = Semaphore.makeUnsafe(1);

/**
 * Set what the bucket policy allows on one stage, keeping every statement
 * alchemy doesn't own.
 */
export const setStageAccess = (
  location: LegacyLocation,
  stack: string,
  stage: string,
  access: StageAccess,
) =>
  Semaphore.withPermits(
    policyLock,
    1,
  )(
    Effect.gen(function* () {
      const arn = `arn:aws:s3:::${location.bucket}/${stagePrefix(location, stack, stage)}*`;
      const { version, statements } = yield* readPolicy(location.bucket);
      const resources = (sid: string) =>
        new Set(asArray(statements.find((statement) => statement.Sid === sid)?.Resource));
      const fenced = resources(FENCED_SID);
      const migrated = resources(MIGRATED_SID);
      const current: StageAccess = migrated.has(arn)
        ? "migrated"
        : fenced.has(arn)
          ? "fenced"
          : "open";
      if (current === access) return;
      fenced.delete(arn);
      migrated.delete(arn);
      if (access === "fenced") fenced.add(arn);
      if (access === "migrated") migrated.add(arn);
      const deny = (sid: keyof typeof DENIED_ACTIONS, arns: Set<string>) =>
        arns.size === 0
          ? []
          : [
              {
                Sid: sid,
                Effect: "Deny",
                Principal: "*",
                Action: DENIED_ACTIONS[sid],
                Resource: Array.from(arns).sort(),
              },
            ];
      const next = [
        ...statements.filter(
          (statement) => statement.Sid !== FENCED_SID && statement.Sid !== MIGRATED_SID,
        ),
        ...deny(FENCED_SID, fenced),
        ...deny(MIGRATED_SID, migrated),
      ];
      if (next.length === 0) {
        yield* s3.deleteBucketPolicy({ Bucket: location.bucket });
        return;
      }
      const text = JSON.stringify({ Version: version, Statement: next });
      if (new TextEncoder().encode(text).length > MAX_POLICY_BYTES) {
        return yield* new LegacyStateError({
          message: `The bucket policy of '${location.bucket}' has no room to fence '${stack}/${stage}' (S3 allows 20 KB). Migrate fewer stages at a time, or remove statements alchemy doesn't own.`,
        });
      }
      yield* s3.putBucketPolicy({ Bucket: location.bucket, Policy: text });
    }),
  );

/** Remove every statement {@link setStageAccess} wrote, so the bucket can be emptied. */
export const openLegacyBucket = (bucket: string) =>
  Semaphore.withPermits(
    policyLock,
    1,
  )(
    Effect.gen(function* () {
      const { version, statements } = yield* readPolicy(bucket);
      const kept = statements.filter(
        (statement) => statement.Sid !== FENCED_SID && statement.Sid !== MIGRATED_SID,
      );
      if (kept.length === statements.length) return;
      if (kept.length === 0) {
        yield* s3.deleteBucketPolicy({ Bucket: bucket });
      } else {
        yield* s3.putBucketPolicy({
          Bucket: bucket,
          Policy: JSON.stringify({ Version: version, Statement: kept }),
        });
      }
    }),
  );
