import * as AWS from "@/AWS";
import { Channel, ChannelGroup, OriginEndpoint } from "@/AWS/MediaPackageV2";
import * as Test from "@/Test/Alchemy";
import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import { expect } from "alchemy-test";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/reconcile paths depend on.
test.provider(
  "getChannelGroup on a bogus name fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mediapackagev2.getChannelGroup({
          ChannelGroupName: "alchemy-nonexistent-channel-group-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertGroupGone = (channelGroupName: string) =>
  Effect.gen(function* () {
    const status = yield* mediapackagev2
      .getChannelGroup({ ChannelGroupName: channelGroupName })
      .pipe(
        Effect.map(() => "exists" as const),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("gone" as const),
        ),
      );
    if (status !== "gone") {
      return yield* Effect.fail(
        new Error(`channel group '${channelGroupName}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "channel group → channel → origin endpoint lifecycle (create, update, replace, destroy)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployStack = (props: {
        endpointDescription?: string;
        startoverWindow?: Duration.Input;
        containerType: mediapackagev2.ContainerType;
        channelPolicy?: string;
        endpointPolicy?: string;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const group = yield* ChannelGroup("Group", {
              description: "alchemy mediapackagev2 test group",
              tags: { fixture: "mediapackagev2" },
            });
            const channel = yield* Channel("Feed", {
              channelGroupName: group.channelGroupName,
              inputType: "HLS",
              description: "alchemy mediapackagev2 test channel",
              policy: props.channelPolicy,
              tags: { fixture: "mediapackagev2" },
            });
            const endpoint = yield* OriginEndpoint("Playback", {
              channelGroupName: group.channelGroupName,
              channelName: channel.channelName,
              containerType: props.containerType,
              segment: { SegmentDurationSeconds: 6 },
              description: props.endpointDescription,
              startoverWindow: props.startoverWindow,
              hlsManifests: [{ ManifestName: "index" }],
              policy: props.endpointPolicy,
              tags: { fixture: "mediapackagev2" },
            });
            return { group, channel, endpoint };
          }),
        );

      // 1. Greenfield create.
      const first = yield* deployStack({
        endpointDescription: "v1",
        containerType: "TS",
      });

      expect(first.group.channelGroupArn).toContain(":channelGroup/");
      expect(first.group.egressDomain).toContain(".mediapackagev2.");
      expect(first.channel.channelArn).toContain("/channel/");
      expect(first.channel.ingestEndpoints.length).toBeGreaterThan(0);
      expect(first.channel.inputType).toBe("HLS");
      expect(first.endpoint.originEndpointArn).toContain("/originEndpoint/");
      expect(first.endpoint.containerType).toBe("TS");
      expect(first.endpoint.hlsManifests).toHaveLength(1);
      expect(first.endpoint.hlsManifests[0]?.manifestName).toBe("index");
      expect(first.endpoint.hlsManifests[0]?.url).toContain("index.m3u8");

      // Out-of-band verification via distilled.
      const observedGroup = yield* mediapackagev2.getChannelGroup({
        ChannelGroupName: first.group.channelGroupName,
      });
      expect(observedGroup.EgressDomain).toBe(first.group.egressDomain);
      expect(observedGroup.Description).toBe(
        "alchemy mediapackagev2 test group",
      );
      const observedChannel = yield* mediapackagev2.getChannel({
        ChannelGroupName: first.group.channelGroupName,
        ChannelName: first.channel.channelName,
      });
      expect(observedChannel.Arn).toBe(first.channel.channelArn);
      const observedEndpoint = yield* mediapackagev2.getOriginEndpoint({
        ChannelGroupName: first.group.channelGroupName,
        ChannelName: first.channel.channelName,
        OriginEndpointName: first.endpoint.originEndpointName,
      });
      expect(observedEndpoint.Description).toBe("v1");
      expect(observedEndpoint.Tags?.fixture).toBe("mediapackagev2");

      // 2. In-place update: endpoint description + startover window change,
      //    and resource policies are attached to the channel and endpoint;
      //    every ARN must survive.
      const accountId = first.channel.channelArn.split(":")[4]!;
      const channelPolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowIngest",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:root` },
            Action: "mediapackagev2:PutObject",
            Resource: first.channel.channelArn,
          },
        ],
      });
      const endpointPolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowPlayback",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:root` },
            Action: [
              "mediapackagev2:GetObject",
              "mediapackagev2:GetHeadObject",
            ],
            Resource: first.endpoint.originEndpointArn,
          },
        ],
      });
      const second = yield* deployStack({
        endpointDescription: "v2",
        startoverWindow: "5 minutes",
        containerType: "TS",
        channelPolicy,
        endpointPolicy,
      });
      expect(second.group.channelGroupArn).toBe(first.group.channelGroupArn);
      expect(second.channel.channelArn).toBe(first.channel.channelArn);
      expect(second.endpoint.originEndpointArn).toBe(
        first.endpoint.originEndpointArn,
      );
      const updatedEndpoint = yield* mediapackagev2.getOriginEndpoint({
        ChannelGroupName: second.group.channelGroupName,
        ChannelName: second.channel.channelName,
        OriginEndpointName: second.endpoint.originEndpointName,
      });
      expect(updatedEndpoint.Description).toBe("v2");
      expect(updatedEndpoint.StartoverWindowSeconds).toBe(300);
      // Policies landed — verify out-of-band.
      const observedChannelPolicy = yield* mediapackagev2.getChannelPolicy({
        ChannelGroupName: second.group.channelGroupName,
        ChannelName: second.channel.channelName,
      });
      expect(JSON.parse(observedChannelPolicy.Policy).Statement[0].Sid).toBe(
        "AllowIngest",
      );
      const observedEndpointPolicy =
        yield* mediapackagev2.getOriginEndpointPolicy({
          ChannelGroupName: second.group.channelGroupName,
          ChannelName: second.channel.channelName,
          OriginEndpointName: second.endpoint.originEndpointName,
        });
      expect(JSON.parse(observedEndpointPolicy.Policy).Statement[0].Sid).toBe(
        "AllowPlayback",
      );

      // 3. Replacement: the container type is immutable, so TS → CMAF must
      //    replace the endpoint (new physical name) while the channel and
      //    group stay in place. Policies are dropped, exercising the
      //    delete-policy sync path on the surviving channel.
      const third = yield* deployStack({
        endpointDescription: "v2",
        startoverWindow: "5 minutes",
        containerType: "CMAF",
      });
      expect(third.group.channelGroupArn).toBe(first.group.channelGroupArn);
      expect(third.channel.channelArn).toBe(first.channel.channelArn);
      expect(third.endpoint.originEndpointArn).not.toBe(
        first.endpoint.originEndpointArn,
      );
      expect(third.endpoint.originEndpointName).not.toBe(
        first.endpoint.originEndpointName,
      );
      expect(third.endpoint.containerType).toBe("CMAF");
      // The replaced endpoint is deleted.
      const oldEndpointError = yield* Effect.flip(
        mediapackagev2.getOriginEndpoint({
          ChannelGroupName: first.group.channelGroupName,
          ChannelName: first.channel.channelName,
          OriginEndpointName: first.endpoint.originEndpointName,
        }),
      );
      expect(oldEndpointError._tag).toBe("ResourceNotFoundException");
      // The channel policy was removed (policy prop dropped).
      const removedPolicyError = yield* Effect.flip(
        mediapackagev2.getChannelPolicy({
          ChannelGroupName: third.group.channelGroupName,
          ChannelName: third.channel.channelName,
        }),
      );
      expect(removedPolicyError._tag).toBe("ResourceNotFoundException");

      // 4. Destroy everything (endpoint → channel → group) and verify the
      //    group is gone out-of-band.
      yield* stack.destroy();
      yield* assertGroupGone(first.group.channelGroupName);
    }),
  { timeout: 300_000 },
);
