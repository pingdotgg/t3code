import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as MediaLive from "@/AWS/MediaLive";
import type * as medialive from "@distilled.cloud/aws/medialive";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "channel-handler.ts");

// A minimal single-pipeline UDP encoder config — the cheapest valid
// encoder settings. The channel is provisioned IDLE and never started.
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

export class MediaLiveChannelTestFunction extends Lambda.Function<Lambda.Function>()(
  "MediaLiveChannelTestFunction",
) {}

export default MediaLiveChannelTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const role = yield* IAM.Role("ChannelBindingRole", {
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
    const input = yield* MediaLive.Input("ChannelBindingInput", {
      type: "URL_PULL",
      sources: [{ Url: "https://example.com/stream/index.m3u8" }],
    });
    // The channel the channel-scoped bindings are bound to. It is created
    // IDLE (which does not bill — only RUNNING channels do) and nothing
    // ever starts it, so the observability ops see the typed not-running
    // behavior.
    const channel = yield* MediaLive.Channel("BindingChannel", {
      channelClass: "SINGLE_PIPELINE",
      roleArn: role.roleArn,
      inputAttachments: [
        {
          InputId: input.inputId,
          InputAttachmentName: "primary",
          InputSettings: { AudioSelectors: [{ Name: "default" }] },
        },
      ],
      inputSpecification: {
        Codec: "AVC",
        Resolution: "SD",
        MaximumBitrate: "MAX_10_MBPS",
      },
      destinations: [
        { Id: "dest1", Settings: [{ Url: "udp://10.220.171.28:5000" }] },
      ],
      encoderSettings: ENCODER_SETTINGS,
      tags: { fixture: "medialive-channel-bindings" },
    });

    const describeChannel = yield* MediaLive.DescribeChannel(channel);
    const describeSchedule = yield* MediaLive.DescribeSchedule(channel);
    const updateSchedule = yield* MediaLive.BatchUpdateSchedule(channel);
    const deleteSchedule = yield* MediaLive.DeleteSchedule(channel);
    const listAlerts = yield* MediaLive.ListAlerts(channel);
    const describeThumbnails = yield* MediaLive.DescribeThumbnails(channel);
    const startChannel = yield* MediaLive.StartChannel(channel);
    const stopChannel = yield* MediaLive.StopChannel(channel);
    const restartPipelines = yield* MediaLive.RestartChannelPipelines(channel);

    // startChannel / stopChannel / restartPipelines are bound (their IAM
    // grants are attached and their init proved) but never driven — a
    // RUNNING channel bills by the hour.
    const bound = {
      describeChannel,
      describeSchedule,
      updateSchedule,
      deleteSchedule,
      listAlerts,
      describeThumbnails,
      startChannel,
      stopChannel,
      restartPipelines,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Read the channel's live state — the fixture channel idles IDLE.
        if (request.method === "GET" && pathname === "/channel") {
          const current = yield* describeChannel();
          return yield* HttpServerResponse.json({
            state: current.State,
            channelClass: current.ChannelClass,
            pipelinesRunning: current.PipelinesRunningCount,
          });
        }

        // The schedule of a freshly-created channel is empty.
        if (request.method === "GET" && pathname === "/schedule") {
          const { ScheduleActions } = yield* describeSchedule();
          return yield* HttpServerResponse.json({
            actions: (ScheduleActions ?? []).length,
          });
        }

        // Program a fixed-time input switch far in the future, observe it
        // in the schedule, then clear the schedule — a full
        // BatchUpdateSchedule/DescribeSchedule/DeleteSchedule roundtrip on
        // an IDLE channel.
        if (request.method === "POST" && pathname === "/schedule-cycle") {
          const startTime = yield* Effect.sync(() =>
            new Date(Date.now() + 3_600_000).toISOString(),
          );
          const result = yield* updateSchedule({
            Creates: {
              ScheduleActions: [
                {
                  ActionName: "alchemy-binding-test",
                  ScheduleActionStartSettings: {
                    FixedModeScheduleActionStartSettings: { Time: startTime },
                  },
                  ScheduleActionSettings: {
                    InputSwitchSettings: {
                      InputAttachmentNameReference: "primary",
                    },
                  },
                },
              ],
            },
          }).pipe(
            Effect.flatMap(() => describeSchedule()),
            Effect.flatMap(({ ScheduleActions }) =>
              deleteSchedule().pipe(
                Effect.map(() => ({
                  created: (ScheduleActions ?? []).length,
                  cleared: true,
                  tag: undefined as string | undefined,
                })),
              ),
            ),
            Effect.catchTag(
              ["BadRequestException", "UnprocessableEntityException"],
              (e) =>
                Effect.succeed({
                  created: 0,
                  cleared: false,
                  tag: e._tag as string | undefined,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // A channel that has never run has no (or only informational)
        // alerts; the call itself must succeed.
        if (request.method === "GET" && pathname === "/alerts") {
          const { Alerts } = yield* listAlerts();
          return yield* HttpServerResponse.json({
            alerts: (Alerts ?? []).length,
          });
        }

        // Thumbnails on an IDLE channel: either empty details or the typed
        // BadRequestException (thumbnails require a running channel).
        if (request.method === "GET" && pathname === "/thumbnails") {
          const result = yield* describeThumbnails({ PipelineId: "0" }).pipe(
            Effect.map(({ ThumbnailDetails }) => ({
              details: (ThumbnailDetails ?? []).length,
              tag: undefined as string | undefined,
            })),
            Effect.catchTag("BadRequestException", (e) =>
              Effect.succeed({ details: 0, tag: e._tag as string | undefined }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        MediaLive.DescribeChannelHttp,
        MediaLive.DescribeScheduleHttp,
        MediaLive.BatchUpdateScheduleHttp,
        MediaLive.DeleteScheduleHttp,
        MediaLive.ListAlertsHttp,
        MediaLive.DescribeThumbnailsHttp,
        MediaLive.StartChannelHttp,
        MediaLive.StopChannelHttp,
        MediaLive.RestartChannelPipelinesHttp,
      ),
    ),
  ),
);
