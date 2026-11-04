import * as Effect from "effect/Effect";
import type { BucketNotification } from "./BucketNotifications.ts";
import type { S3EventType, S3Record } from "./S3Event.ts";

export const normalizeBucketNotification = (record: S3Record) =>
  Effect.sync((): BucketNotification => ({
    type: `s3:${record.eventName.replace(/^s3:/, "")}` as S3EventType,
    bucket: record.s3.bucket.name,
    key: decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")),
    size: record.s3.object.size,
    eTag: record.s3.object.eTag,
    versionId: record.s3.object.versionId ?? undefined,
    sequencer: record.s3.object.sequencer,
  }));
