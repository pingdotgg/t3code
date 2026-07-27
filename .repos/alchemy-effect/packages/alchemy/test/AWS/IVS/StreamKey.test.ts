import * as AWS from "@/AWS";
import { Channel, StreamKey } from "@/AWS/IVS";
import * as Test from "@/Test/Alchemy";
import * as ivs from "@distilled.cloud/aws/ivs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertStreamKeyGone = (arn: string) =>
  Effect.gen(function* () {
    const streamKey = yield* ivs.getStreamKey({ arn }).pipe(
      Effect.map((r) => r.streamKey),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (streamKey !== undefined) {
      return yield* Effect.fail(new Error(`stream key '${arn}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// CreateChannel auto-provisions a channel's single allowed stream key, so
// this also covers the adopt-the-default-key path of the provider.
test.provider(
  "manage the stream key of a channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const channel = yield* Channel("KeyedChannel", {
            channelName: "alchemy-test-ivs-streamkey-channel",
            type: "BASIC",
          });
          const streamKey = yield* StreamKey("Key", {
            channelArn: channel.channelArn,
            tags: { fixture: "ivs-stream-key" },
          });
          return { channel, streamKey };
        }),
      );

      expect(deployed.streamKey.streamKeyArn).toContain(":stream-key/");
      expect(deployed.streamKey.channelArn).toBe(deployed.channel.channelArn);
      expect(deployed.streamKey.value).toBeDefined();
      expect(Redacted.value(deployed.streamKey.value!)).toMatch(/^sk_/);

      // Out-of-band verification via distilled: the key is tagged ours
      // (the provider adopted the channel's auto-created key or created
      // one — either way tags must have converged).
      const observed = yield* ivs.getStreamKey({
        arn: deployed.streamKey.streamKeyArn,
      });
      expect(observed.streamKey?.channelArn).toBe(deployed.channel.channelArn);
      expect(observed.streamKey?.tags?.fixture).toBe("ivs-stream-key");
      expect(observed.streamKey?.tags?.["alchemy::id"]).toBe("Key");

      // The channel must have exactly one key (we adopted, not duplicated).
      const listed = yield* ivs.listStreamKeys({
        channelArn: deployed.channel.channelArn,
      });
      expect(listed.streamKeys.length).toBe(1);

      // No-op redeploy keeps the same key.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const channel = yield* Channel("KeyedChannel", {
            channelName: "alchemy-test-ivs-streamkey-channel",
            type: "BASIC",
          });
          const streamKey = yield* StreamKey("Key", {
            channelArn: channel.channelArn,
            tags: { fixture: "ivs-stream-key" },
          });
          return { channel, streamKey };
        }),
      );
      expect(redeployed.streamKey.streamKeyArn).toBe(
        deployed.streamKey.streamKeyArn,
      );

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertStreamKeyGone(deployed.streamKey.streamKeyArn);
    }),
  { timeout: 240_000 },
);
