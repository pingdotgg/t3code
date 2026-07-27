import * as AWS from "@/AWS";
import { Channel, Input, InputSecurityGroup } from "@/AWS/MediaLive";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as medialive from "@distilled.cloud/aws/medialive";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic, run-stable physical names (never Date.now()).
const PULL_INPUT_NAME = "alchemy-test-ml-pull-input";
const PUSH_INPUT_NAME = "alchemy-test-ml-push-input";
const CHANNEL_NAME = "alchemy-test-ml-channel";

class StillExists extends Data.TaggedError("StillExists")<{
  readonly id: string;
}> {}

// ---------------------------------------------------------------------------
// Ungated typed-error probes — prove the distilled error union carries the
// not-found tag the read/delete paths depend on, at near-zero cost.
// ---------------------------------------------------------------------------

test.provider(
  "describeChannel/describeInput/describeInputSecurityGroup on a bogus id fail with NotFoundException",
  () =>
    Effect.gen(function* () {
      const c = yield* Effect.flip(
        medialive.describeChannel({ ChannelId: "9999999" }),
      );
      expect(c._tag).toBe("NotFoundException");
      const i = yield* Effect.flip(
        medialive.describeInput({ InputId: "9999999" }),
      );
      expect(i._tag).toBe("NotFoundException");
      const g = yield* Effect.flip(
        medialive.describeInputSecurityGroup({
          InputSecurityGroupId: "9999999",
        }),
      );
      expect(g._tag).toBe("NotFoundException");
    }),
);

// ---------------------------------------------------------------------------
// InputSecurityGroup lifecycle — free and fast.
// ---------------------------------------------------------------------------

test.provider(
  "InputSecurityGroup: create, update whitelist rules, and destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* InputSecurityGroup("Allowlist", {
            whitelistRules: ["10.0.0.0/16"],
            tags: { Environment: "test" },
          });
        }),
      );
      expect(created.inputSecurityGroupId).toBeTruthy();
      expect(created.inputSecurityGroupArn).toContain(":inputSecurityGroup:");
      expect(created.whitelistRules).toEqual(["10.0.0.0/16"]);

      // Out-of-band verification via distilled, including ownership tags.
      const observed = yield* medialive.describeInputSecurityGroup({
        InputSecurityGroupId: created.inputSecurityGroupId,
      });
      expect(observed.WhitelistRules?.map((r) => r.Cidr)).toEqual([
        "10.0.0.0/16",
      ]);
      expect(observed.Tags?.["alchemy::id"]).toBe("Allowlist");
      expect(observed.Tags?.["Environment"]).toBe("test");

      // Update: change the whitelist + tags in place (same id).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* InputSecurityGroup("Allowlist", {
            whitelistRules: ["10.1.0.0/16", "192.168.0.0/24"],
            tags: { Environment: "test", Extra: "yes" },
          });
        }),
      );
      expect(updated.inputSecurityGroupId).toBe(created.inputSecurityGroupId);
      expect([...updated.whitelistRules].sort()).toEqual([
        "10.1.0.0/16",
        "192.168.0.0/24",
      ]);

      const observed2 = yield* medialive.describeInputSecurityGroup({
        InputSecurityGroupId: created.inputSecurityGroupId,
      });
      expect(observed2.WhitelistRules?.map((r) => r.Cidr)?.sort()).toEqual([
        "10.1.0.0/16",
        "192.168.0.0/24",
      ]);
      expect(observed2.Tags?.["Extra"]).toBe("yes");

      yield* stack.destroy();
      yield* assertInputSecurityGroupDeleted(created.inputSecurityGroupId);
    }),
  { timeout: 120_000 },
);

// ---------------------------------------------------------------------------
// Input lifecycle — a URL_PULL input needs no security group; covers update
// (sources) plus replacement (type is immutable).
// ---------------------------------------------------------------------------

test.provider(
  "Input: create URL_PULL, update sources, replace on type change, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Input("Pull", {
            name: PULL_INPUT_NAME,
            type: "URL_PULL",
            sources: [{ Url: "https://example.com/stream/index.m3u8" }],
            tags: { Environment: "test" },
          });
        }),
      );
      expect(created.inputId).toBeTruthy();
      expect(created.inputArn).toContain(":input:");
      expect(created.inputName).toBe(PULL_INPUT_NAME);
      expect(created.type).toBe("URL_PULL");
      expect(created.state === "DETACHED" || created.state === "ATTACHED").toBe(
        true,
      );

      const observed = yield* medialive.describeInput({
        InputId: created.inputId,
      });
      expect(observed.Sources?.map((s) => s.Url)).toEqual([
        "https://example.com/stream/index.m3u8",
      ]);
      expect(observed.Tags?.["alchemy::id"]).toBe("Pull");

      // Update: swap the pull URL in place (same id).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Input("Pull", {
            name: PULL_INPUT_NAME,
            type: "URL_PULL",
            sources: [{ Url: "https://example.com/stream/other.m3u8" }],
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.inputId).toBe(created.inputId);

      const observed2 = yield* medialive.describeInput({
        InputId: created.inputId,
      });
      expect(observed2.Sources?.map((s) => s.Url)).toEqual([
        "https://example.com/stream/other.m3u8",
      ]);

      // Replace: the input type is immutable, so switching to MP4_FILE must
      // produce a NEW input id.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Input("Pull", {
            name: PULL_INPUT_NAME,
            type: "MP4_FILE",
            sources: [{ Url: "s3ssl://alchemy-nonexistent/in.mp4" }],
            tags: { Environment: "test" },
          });
        }),
      );
      expect(replaced.type).toBe("MP4_FILE");
      expect(replaced.inputId).not.toBe(created.inputId);
      yield* assertInputDeleted(created.inputId);

      yield* stack.destroy();
      yield* assertInputDeleted(replaced.inputId);
    }),
  { timeout: 180_000 },
);

// ---------------------------------------------------------------------------
// Composition: an RTMP_PUSH input gated by an input security group. Also
// exercises the delete ordering (the group is IN_USE until the input is
// fully deleted).
// ---------------------------------------------------------------------------

test.provider(
  "Input + InputSecurityGroup: RTMP_PUSH input behind an allowlist",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { isg, input } = yield* stack.deploy(
        Effect.gen(function* () {
          const isg = yield* InputSecurityGroup("PushAllowlist", {
            whitelistRules: ["0.0.0.0/0"],
          });
          const input = yield* Input("Push", {
            name: PUSH_INPUT_NAME,
            type: "RTMP_PUSH",
            inputSecurityGroups: [isg.inputSecurityGroupId],
            destinations: [
              { StreamName: "live/primary" },
              { StreamName: "live/secondary" },
            ],
          });
          return { isg, input };
        }),
      );
      expect(input.securityGroups).toEqual([isg.inputSecurityGroupId]);
      // A STANDARD-class push input exposes two ingest endpoints.
      expect(input.destinations.length).toBe(2);
      expect(input.destinations[0].Url).toContain("rtmp");

      const observedIsg = yield* medialive.describeInputSecurityGroup({
        InputSecurityGroupId: isg.inputSecurityGroupId,
      });
      expect(observedIsg.Inputs).toContain(input.inputId);

      yield* stack.destroy();
      yield* assertInputDeleted(input.inputId);
      yield* assertInputSecurityGroupDeleted(isg.inputSecurityGroupId);
    }),
  { timeout: 180_000 },
);

// ---------------------------------------------------------------------------
// Channel lifecycle — channels are heavy (slow create, billed per RUNNING
// hour). Gated behind AWS_TEST_MEDIALIVE=1; the channel is provisioned IDLE
// and never started.
// ---------------------------------------------------------------------------

const ENCODER_SETTINGS: medialive.EncoderSettings = {
  TimecodeConfig: { Source: "EMBEDDED" },
  AudioDescriptions: [
    {
      Name: "audio_1",
      AudioSelectorName: "default",
      CodecSettings: {
        AacSettings: { Bitrate: 96000, SampleRate: 48000 },
      },
    },
  ],
  VideoDescriptions: [
    {
      Name: "video_1",
      Width: 640,
      Height: 360,
      CodecSettings: {
        H264Settings: {
          Bitrate: 1000000,
          FramerateControl: "SPECIFIED",
          FramerateNumerator: 30,
          FramerateDenominator: 1,
          GopSize: 60,
        },
      },
    },
  ],
  OutputGroups: [
    {
      Name: "udp",
      OutputGroupSettings: { UdpGroupSettings: {} },
      Outputs: [
        {
          OutputName: "output_1",
          VideoDescriptionName: "video_1",
          AudioDescriptionNames: ["audio_1"],
          OutputSettings: {
            UdpOutputSettings: {
              Destination: { DestinationRefId: "dest1" },
              ContainerSettings: { M2tsSettings: {} },
            },
          },
        },
      ],
    },
  ],
};

test.provider.skipIf(!process.env.AWS_TEST_MEDIALIVE)(
  "Channel: create IDLE single-pipeline channel, update log level, destroy (gated AWS_TEST_MEDIALIVE=1)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { channel, input } = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Role("MediaLiveRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "medialive.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
          });
          const input = yield* Input("ChannelPull", {
            type: "URL_PULL",
            sources: [{ Url: "https://example.com/stream/index.m3u8" }],
          });
          const channel = yield* Channel("Live", {
            name: CHANNEL_NAME,
            channelClass: "SINGLE_PIPELINE",
            roleArn: role.roleArn,
            inputAttachments: [
              {
                InputId: input.inputId,
                InputAttachmentName: "primary",
                InputSettings: {
                  AudioSelectors: [{ Name: "default" }],
                },
              },
            ],
            inputSpecification: {
              Codec: "AVC",
              Resolution: "SD",
              MaximumBitrate: "MAX_10_MBPS",
            },
            destinations: [
              {
                Id: "dest1",
                Settings: [{ Url: "udp://10.220.171.28:5000" }],
              },
            ],
            encoderSettings: ENCODER_SETTINGS,
            tags: { Environment: "test" },
          });
          return { channel, input };
        }),
      );
      expect(channel.channelId).toBeTruthy();
      expect(channel.channelArn).toContain(":channel:");
      expect(channel.channelName).toBe(CHANNEL_NAME);
      expect(channel.channelClass).toBe("SINGLE_PIPELINE");
      // NEVER started — provisioned and left IDLE.
      expect(channel.state).toBe("IDLE");

      const observed = yield* medialive.describeChannel({
        ChannelId: channel.channelId,
      });
      expect(observed.State).toBe("IDLE");
      expect(observed.Tags?.["alchemy::id"]).toBe("Live");

      // Update: bump the log level in place (same id), channel stays IDLE.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Role("MediaLiveRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "medialive.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
          });
          const input = yield* Input("ChannelPull", {
            type: "URL_PULL",
            sources: [{ Url: "https://example.com/stream/index.m3u8" }],
          });
          return {
            channel: yield* Channel("Live", {
              name: CHANNEL_NAME,
              channelClass: "SINGLE_PIPELINE",
              roleArn: role.roleArn,
              logLevel: "ERROR",
              inputAttachments: [
                {
                  InputId: input.inputId,
                  InputAttachmentName: "primary",
                  InputSettings: {
                    AudioSelectors: [{ Name: "default" }],
                  },
                },
              ],
              inputSpecification: {
                Codec: "AVC",
                Resolution: "SD",
                MaximumBitrate: "MAX_10_MBPS",
              },
              destinations: [
                {
                  Id: "dest1",
                  Settings: [{ Url: "udp://10.220.171.28:5000" }],
                },
              ],
              encoderSettings: ENCODER_SETTINGS,
              tags: { Environment: "test" },
            }),
            input,
          };
        }),
      );
      expect(updated.channel.channelId).toBe(channel.channelId);

      const observed2 = yield* medialive.describeChannel({
        ChannelId: channel.channelId,
      });
      expect(observed2.LogLevel).toBe("ERROR");
      expect(observed2.State).toBe("IDLE");

      yield* stack.destroy();
      yield* assertChannelDeleted(channel.channelId);
      yield* assertInputDeleted(input.inputId);
    }),
  { timeout: 600_000 },
);

// ---------------------------------------------------------------------------
// Deletion assertions — typed wait-until-gone.
// ---------------------------------------------------------------------------

const assertInputDeleted = (inputId: string) =>
  medialive.describeInput({ InputId: inputId }).pipe(
    Effect.flatMap((input) =>
      input.State === "DELETED" || input.State === "DELETING"
        ? Effect.void
        : Effect.fail(new StillExists({ id: inputId })),
    ),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const assertInputSecurityGroupDeleted = (id: string) =>
  medialive.describeInputSecurityGroup({ InputSecurityGroupId: id }).pipe(
    Effect.flatMap((isg) =>
      isg.State === "DELETED"
        ? Effect.void
        : Effect.fail(new StillExists({ id })),
    ),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const assertChannelDeleted = (channelId: string) =>
  medialive.describeChannel({ ChannelId: channelId }).pipe(
    Effect.flatMap((channel) =>
      channel.State === "DELETED" || channel.State === "DELETING"
        ? Effect.void
        : Effect.fail(new StillExists({ id: channelId })),
    ),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );
