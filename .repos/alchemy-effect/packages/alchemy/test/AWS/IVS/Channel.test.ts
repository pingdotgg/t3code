import * as AWS from "@/AWS";
import { Channel } from "@/AWS/IVS";
import * as Test from "@/Test/Alchemy";
import * as ivs from "@distilled.cloud/aws/ivs";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getChannel on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        ivs.getChannel({
          arn: `arn:aws:ivs:${region}:${Account}:channel/AbCdEfGh1234`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const assertChannelGone = (arn: string) =>
  Effect.gen(function* () {
    const channel = yield* ivs.getChannel({ arn }).pipe(
      Effect.map((r) => r.channel),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (channel !== undefined) {
      return yield* Effect.fail(new Error(`channel '${arn}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Channels are free while idle and provision synchronously — the full
// lifecycle (create, no-op, update-in-place, destroy) runs ungated.
test.provider(
  "create, update, and destroy an IVS channel",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const props = {
        channelName: "alchemy-test-ivs-channel",
        latencyMode: "LOW" as const,
        type: "BASIC",
        tags: { fixture: "ivs-channel" },
      };

      // Create.
      const created = yield* stack.deploy(Channel("Live", props));
      expect(created.channelName).toBe("alchemy-test-ivs-channel");
      expect(created.channelArn).toContain(":channel/");
      expect(created.ingestEndpoint).toBeDefined();
      expect(created.playbackUrl).toContain("https://");
      expect(created.type).toBe("BASIC");
      expect(created.latencyMode).toBe("LOW");

      // Out-of-band verification via distilled.
      const observed = yield* ivs.getChannel({ arn: created.channelArn });
      expect(observed.channel?.name).toBe("alchemy-test-ivs-channel");
      expect(observed.channel?.type).toBe("BASIC");
      expect(observed.channel?.tags?.fixture).toBe("ivs-channel");
      expect(observed.channel?.tags?.["alchemy::id"]).toBe("Live");

      // No-op redeploy keeps the same channel.
      const noop = yield* stack.deploy(Channel("Live", props));
      expect(noop.channelArn).toBe(created.channelArn);

      // Update in place — latency mode, authorization, and name are all
      // mutable; the ARN must not change.
      const updated = yield* stack.deploy(
        Channel("Live", {
          ...props,
          channelName: "alchemy-test-ivs-channel-b",
          latencyMode: "NORMAL",
          authorized: true,
        }),
      );
      expect(updated.channelArn).toBe(created.channelArn);
      expect(updated.channelName).toBe("alchemy-test-ivs-channel-b");
      expect(updated.latencyMode).toBe("NORMAL");
      expect(updated.authorized).toBe(true);

      const reobserved = yield* ivs.getChannel({ arn: created.channelArn });
      expect(reobserved.channel?.name).toBe("alchemy-test-ivs-channel-b");
      expect(reobserved.channel?.latencyMode).toBe("NORMAL");
      expect(reobserved.channel?.authorized).toBe(true);

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertChannelGone(created.channelArn);
    }),
  { timeout: 240_000 },
);
