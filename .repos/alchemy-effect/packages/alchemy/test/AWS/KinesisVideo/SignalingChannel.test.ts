import * as AWS from "@/AWS";
import { SignalingChannel } from "@/AWS/KinesisVideo";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findChannel = (channelName: string) =>
  kv.describeSignalingChannel({ ChannelName: channelName }).pipe(
    Effect.map((r) => r.ChannelInfo),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class ChannelStillExists extends Data.TaggedError("ChannelStillExists")<{
  readonly channelName: string;
}> {}

// DeleteSignalingChannel is asynchronous: the channel lingers in DELETING
// for a while — treat DELETING as deleted.
const assertChannelDeleted = (channelName: string) =>
  findChannel(channelName).pipe(
    Effect.flatMap((info) =>
      info === undefined || info.ChannelStatus === "DELETING"
        ? Effect.void
        : Effect.fail(new ChannelStillExists({ channelName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ChannelStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

test.provider(
  "create, update message TTL and tags, delete signaling channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const channel = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SignalingChannel("TestSignalingChannel", {
            tags: { Environment: "test" },
          });
        }),
      );

      expect(channel.channelName).toBeDefined();
      expect(channel.channelArn).toContain(":channel/");

      // out-of-band verification via distilled
      const created = yield* findChannel(channel.channelName);
      expect(created?.ChannelStatus).toBe("ACTIVE");
      expect(created?.ChannelType).toBe("SINGLE_MASTER");
      const tags = yield* kv
        .listTagsForResource({ ResourceARN: channel.channelArn })
        .pipe(Effect.map((r) => r.Tags ?? {}));
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestSignalingChannel");

      // update the message TTL in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SignalingChannel("TestSignalingChannel", {
            messageTtl: "30 seconds",
            tags: { Environment: "test", Extra: "yes" },
          });
        }),
      );
      expect(updated.channelName).toBe(channel.channelName);
      expect(updated.channelArn).toBe(channel.channelArn);

      const afterUpdate = yield* findChannel(channel.channelName);
      expect(afterUpdate?.SingleMasterConfiguration?.MessageTtlSeconds).toBe(
        30,
      );
      const tagsAfter = yield* kv
        .listTagsForResource({ ResourceARN: channel.channelArn })
        .pipe(Effect.map((r) => r.Tags ?? {}));
      expect(tagsAfter.Extra).toBe("yes");

      yield* stack.destroy();
      yield* assertChannelDeleted(channel.channelName);
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
          return yield* SignalingChannel("NamedSignalingChannel", {
            channelName: "alchemy-test-kvs-channel-a",
          });
        }),
      );
      expect(first.channelName).toBe("alchemy-test-kvs-channel-a");

      // renaming triggers a replacement: new physical channel, old gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SignalingChannel("NamedSignalingChannel", {
            channelName: "alchemy-test-kvs-channel-b",
          });
        }),
      );
      expect(second.channelName).toBe("alchemy-test-kvs-channel-b");
      expect(second.channelArn).not.toBe(first.channelArn);

      yield* assertChannelDeleted(first.channelName);

      yield* stack.destroy();
      yield* assertChannelDeleted(second.channelName);
    }),
  { timeout: 240_000 },
);
