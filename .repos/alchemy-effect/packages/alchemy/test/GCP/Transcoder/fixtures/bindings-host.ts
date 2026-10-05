import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

const sdConfig: GCP.Transcoder.JobConfig = {
  elementaryStreams: [
    {
      key: "video-stream0",
      videoStream: {
        h264: {
          heightPixels: 360,
          widthPixels: 640,
          bitrateBps: 550000,
          frameRate: 30,
        },
      },
    },
    {
      key: "audio-stream0",
      audioStream: { codec: "aac", bitrateBps: 64000 },
    },
  ],
  muxStreams: [
    {
      key: "sd",
      container: "mp4",
      elementaryStreams: ["video-stream0", "audio-stream0"],
    },
  ],
};

export const Template = GCP.Transcoder.JobTemplate("WebSd", {
  location: "us-central1",
  config: sdConfig,
});

export const Media = GCP.Storage.Bucket("Media", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/**
 * Effect-native Cloud Run service exercising the Transcoder binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class TranscoderBindingsHost extends GCP.Function<TranscoderBindingsHost>()(
  "TranscoderBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const createJob = yield* GCP.Transcoder.CreateJob(Template);
    const media = yield* Media;
    const bucketName = yield* media.bucketName;

    return {
      fetch: serveProbes({
        createJob: Effect.gen(function* () {
          const bucket = yield* bucketName;
          const job = yield* createJob({
            body: {
              inputUri: `gs://${bucket}/inputs/file.mp4`,
              outputUri: `gs://${bucket}/outputs/`,
              ttlAfterCompletionDays: 1,
            },
          });
          return {
            name: job.name,
            muxStreams: (job.config?.muxStreams ?? []).map(
              (stream) => stream.key,
            ),
          };
        }),
      }),
    };
  }).pipe(Effect.provide(GCP.Transcoder.CreateJobHttp)),
) {}
