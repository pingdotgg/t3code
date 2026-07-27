import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBucketBinding, makeHelpers } from "./BucketBinding.ts";
import { makeRead } from "./ReadBucketBinding.ts";
import {
  ReadWriteBucket,
  type ReadWriteBucketClient,
} from "./ReadWriteBucket.ts";
import { makeWrite } from "./WriteBucketBinding.ts";

/**
 * Implementation of the {@link ReadWriteBucket} binding that uses a Worker binding.
 */
export const ReadWriteBucketBinding = Layer.effect(
  ReadWriteBucket,
  Effect.suspend(() => makeBucketBinding({ makeClient: makeReadWrite })),
);

/** Build the read-write binding client from its read and write halves. */
export const makeReadWrite = (
  helpers: ReturnType<typeof makeHelpers>,
): ReadWriteBucketClient =>
  ({
    ...makeRead(helpers),
    ...makeWrite(helpers),
  }) satisfies ReadWriteBucketClient;
