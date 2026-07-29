import * as AWS from "@/AWS";
import {
  deleteChannelWithEndpoints,
  listAllChannelGroups,
  listGroupChannels,
  retryWhileMpConflict,
} from "@/AWS/MediaPackageV2/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// One-off orphan sweep for the account's MediaPackageV2 surface. Deletes
// EVERY channel group (reaping channels + origin endpoints first, exercising
// the provider's reap-children delete path) and asserts zero remain.
// Env-gated so it can never race the lifecycle suite's own deployments.
test.provider.skipIf(!process.env.MPV2_SWEEP)(
  "sweep: reap every channel group and verify zero remain",
  () =>
    Effect.gen(function* () {
      // Plant a deterministic orphan chain (group -> channel -> endpoint)
      // out-of-band so the sweep provably reaps children before the group —
      // the exact scenario that leaked under nuke.
      yield* mediapackagev2
        .createChannelGroup({ ChannelGroupName: "alchemy-mpv2-sweep-probe" })
        .pipe(Effect.catchTag("ConflictException", () => Effect.void));
      yield* mediapackagev2
        .createChannel({
          ChannelGroupName: "alchemy-mpv2-sweep-probe",
          ChannelName: "probe-feed",
          InputType: "HLS",
        })
        .pipe(Effect.catchTag("ConflictException", () => Effect.void));
      yield* mediapackagev2
        .createOriginEndpoint({
          ChannelGroupName: "alchemy-mpv2-sweep-probe",
          ChannelName: "probe-feed",
          OriginEndpointName: "probe-playback",
          ContainerType: "TS",
          Segment: { SegmentDurationSeconds: 6 },
          HlsManifests: [{ ManifestName: "index" }],
        })
        .pipe(Effect.catchTag("ConflictException", () => Effect.void));

      const groups = yield* listAllChannelGroups();
      expect(groups.length).toBeGreaterThanOrEqual(1);
      yield* Effect.forEach(
        groups,
        (group) =>
          Effect.gen(function* () {
            const channels = yield* listGroupChannels(group.ChannelGroupName);
            yield* Effect.forEach(
              channels,
              (channel) =>
                deleteChannelWithEndpoints(
                  group.ChannelGroupName,
                  channel.ChannelName,
                ),
              { concurrency: 5, discard: true },
            );
            yield* mediapackagev2
              .deleteChannelGroup({ ChannelGroupName: group.ChannelGroupName })
              .pipe(retryWhileMpConflict);
          }),
        { concurrency: 3, discard: true },
      );
      const remaining = yield* listAllChannelGroups();
      expect(remaining).toHaveLength(0);
    }),
  { timeout: 120_000 },
);
