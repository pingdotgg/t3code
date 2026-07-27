import * as AWS from "@/AWS";
import { Stream } from "@/AWS/KinesisVideo";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findStream = (streamName: string) =>
  kv.describeStream({ StreamName: streamName }).pipe(
    Effect.map((r) => r.StreamInfo),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class StreamStillExists extends Data.TaggedError("StreamStillExists")<{
  readonly streamName: string;
}> {}

// DeleteStream is asynchronous: the stream lingers in DELETING (data already
// inaccessible) for a while — treat DELETING as deleted.
const assertStreamDeleted = (streamName: string) =>
  findStream(streamName).pipe(
    Effect.flatMap((info) =>
      info === undefined || info.Status === "DELETING"
        ? Effect.void
        : Effect.fail(new StreamStillExists({ streamName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "StreamStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

const fetchTags = (streamArn: string) =>
  kv
    .listTagsForStream({ StreamARN: streamArn })
    .pipe(Effect.map((r) => r.Tags ?? {}));

test.provider(
  "create, update retention/mediaType/tags, delete video stream",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const stream = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stream("TestVideoStream", {
            dataRetention: "24 hours",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(stream.streamName).toBeDefined();
      expect(stream.streamArn).toContain(":stream/");

      // out-of-band verification via distilled
      const created = yield* findStream(stream.streamName);
      expect(created?.Status).toBe("ACTIVE");
      expect(created?.DataRetentionInHours).toBe(24);
      const tags = yield* fetchTags(stream.streamArn);
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestVideoStream");

      // update: increase retention, set mediaType + deviceName, extra tag
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stream("TestVideoStream", {
            dataRetention: "48 hours",
            mediaType: "video/h264",
            deviceName: "camera-1",
            tags: { Environment: "test", Extra: "yes" },
          });
        }),
      );
      expect(updated.streamName).toBe(stream.streamName);
      expect(updated.streamArn).toBe(stream.streamArn);

      const afterUpdate = yield* findStream(stream.streamName);
      expect(afterUpdate?.DataRetentionInHours).toBe(48);
      expect(afterUpdate?.MediaType).toBe("video/h264");
      expect(afterUpdate?.DeviceName).toBe("camera-1");
      const tagsAfter = yield* fetchTags(stream.streamArn);
      expect(tagsAfter.Extra).toBe("yes");

      // decrease retention back down (DECREASE_DATA_RETENTION path)
      const decreased = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stream("TestVideoStream", {
            dataRetention: "24 hours",
            mediaType: "video/h264",
            deviceName: "camera-1",
            tags: { Environment: "test" },
          });
        }),
      );
      expect(decreased.streamArn).toBe(stream.streamArn);
      const afterDecrease = yield* findStream(stream.streamName);
      expect(afterDecrease?.DataRetentionInHours).toBe(24);
      const tagsAfterRemoval = yield* fetchTags(stream.streamArn);
      expect(tagsAfterRemoval.Extra).toBeUndefined();

      yield* stack.destroy();
      yield* assertStreamDeleted(stream.streamName);
    }),
  { timeout: 240_000 },
);

test.provider(
  "explicit name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stream("NamedVideoStream", {
            streamName: "alchemy-test-kvs-stream-a",
          });
        }),
      );
      expect(first.streamName).toBe("alchemy-test-kvs-stream-a");

      // renaming triggers a replacement: new physical stream, old gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stream("NamedVideoStream", {
            streamName: "alchemy-test-kvs-stream-b",
          });
        }),
      );
      expect(second.streamName).toBe("alchemy-test-kvs-stream-b");
      expect(second.streamArn).not.toBe(first.streamArn);

      yield* assertStreamDeleted(first.streamName);

      yield* stack.destroy();
      yield* assertStreamDeleted(second.streamName);
    }),
  { timeout: 240_000 },
);
