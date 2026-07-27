import * as Lambda from "@/AWS/Lambda";
import * as MediaPackageV2 from "@/AWS/MediaPackageV2";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Deterministic bucket name so the bucket's own policy can reference its
 * ARN without a self-referential Output (MediaPackage writes harvested
 * clips as the `mediapackagev2.amazonaws.com` service principal, which the
 * bucket policy must allow).
 */
const HARVEST_BUCKET = "alchemy-test-mediapackagev2-harvest";

export class MediaPackageV2TestFunction extends Lambda.Function<Lambda.Function>()(
  "MediaPackageV2TestFunction",
) {}

export default MediaPackageV2TestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // The channel-group → channel → endpoint chain the bindings are bound
    // to. Nothing ever pushes content to the channel, so harvest jobs can
    // be created (the schedule sits inside the startover window) but fail
    // asynchronously with "no content" — which is fine: the fixture only
    // proves the runtime call + IAM wiring.
    const group = yield* MediaPackageV2.ChannelGroup("BindingGroup", {
      description: "alchemy mediapackagev2 bindings fixture",
      tags: { fixture: "mediapackagev2-bindings" },
    });
    const channel = yield* MediaPackageV2.Channel("BindingFeed", {
      channelGroupName: group.channelGroupName,
      inputType: "HLS",
      tags: { fixture: "mediapackagev2-bindings" },
    });
    const endpoint = yield* MediaPackageV2.OriginEndpoint("BindingPlayback", {
      channelGroupName: group.channelGroupName,
      channelName: channel.channelName,
      containerType: "TS",
      segment: { SegmentDurationSeconds: 6 },
      startoverWindow: "1 hour",
      hlsManifests: [{ ManifestName: "index" }],
      tags: { fixture: "mediapackagev2-bindings" },
    });

    // Destination bucket for harvested clips, writable by MediaPackage.
    yield* S3.Bucket("HarvestBucket", {
      bucketName: HARVEST_BUCKET,
      forceDestroy: true,
      policy: [
        {
          Sid: "AllowMediaPackageHarvest",
          Effect: "Allow",
          Principal: { Service: "mediapackagev2.amazonaws.com" },
          Action: ["s3:PutObject", "s3:GetBucketLocation"],
          Resource: [
            `arn:aws:s3:::${HARVEST_BUCKET}`,
            `arn:aws:s3:::${HARVEST_BUCKET}/*`,
          ],
        },
      ],
      tags: { fixture: "mediapackagev2-bindings" },
    });

    // Event source: subscribe the host to harvest-job notifications. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* MediaPackageV2.consumeHarvestJobEvents({}, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `mediapackagev2 harvest job ${event.detail.harvestJob.harvestJobName}: ${event.detail.harvestJob.status}`,
        ),
      ),
    );

    const resetChannel = yield* MediaPackageV2.ResetChannelState(channel);
    const resetEndpoint =
      yield* MediaPackageV2.ResetOriginEndpointState(endpoint);
    const createHarvestJob = yield* MediaPackageV2.CreateHarvestJob(endpoint);
    const getHarvestJob = yield* MediaPackageV2.GetHarvestJob(endpoint);
    const cancelHarvestJob = yield* MediaPackageV2.CancelHarvestJob(endpoint);
    const listHarvestJobs = yield* MediaPackageV2.ListHarvestJobs(group);

    const bound = {
      resetChannel,
      resetEndpoint,
      createHarvestJob,
      getHarvestJob,
      cancelHarvestJob,
      listHarvestJobs,
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

        // Reset the channel's ingest state. On an idle channel this
        // trivially succeeds; MediaPackage rate-limits resets, so a
        // repeated run may answer with the typed Conflict/Throttling tag.
        if (request.method === "POST" && pathname === "/reset-channel") {
          const result = yield* resetChannel().pipe(
            Effect.map(({ Arn }) => ({
              arn: Arn as string | undefined,
              tag: undefined as string | undefined,
            })),
            Effect.catchTag(["ConflictException", "ThrottlingException"], (e) =>
              Effect.succeed({
                arn: undefined as string | undefined,
                tag: e._tag as string | undefined,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Reset the endpoint's packaging state — same tolerance as above.
        if (request.method === "POST" && pathname === "/reset-endpoint") {
          const result = yield* resetEndpoint().pipe(
            Effect.map(({ Arn }) => ({
              arn: Arn as string | undefined,
              tag: undefined as string | undefined,
            })),
            Effect.catchTag(["ConflictException", "ThrottlingException"], (e) =>
              Effect.succeed({
                arn: undefined as string | undefined,
                tag: e._tag as string | undefined,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Enumerate the group's harvest jobs.
        if (request.method === "GET" && pathname === "/harvest-jobs") {
          const { Items } = yield* listHarvestJobs();
          return yield* HttpServerResponse.json({
            count: (Items ?? []).length,
          });
        }

        // Full create → get → cancel roundtrip. The channel never received
        // content, so MediaPackage may reject the job upfront with the
        // typed ValidationException — that outcome still proves the binding
        // and its IAM grant.
        if (request.method === "POST" && pathname === "/harvest-cycle") {
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* createHarvestJob({
            HarvestedManifests: {
              HlsManifests: [{ ManifestName: "index" }],
            },
            ScheduleConfiguration: {
              StartTime: new Date(now - 4 * 60_000),
              EndTime: new Date(now - 60_000),
            },
            Destination: {
              S3Destination: {
                BucketName: HARVEST_BUCKET,
                DestinationPath: "clips/",
              },
            },
          }).pipe(
            Effect.flatMap((job) =>
              Effect.gen(function* () {
                const { Status } = yield* getHarvestJob({
                  HarvestJobName: job.HarvestJobName,
                });
                // Cancel is only legal while QUEUED/IN_PROGRESS; a job that
                // already settled answers with the typed Conflict.
                const cancelled = yield* cancelHarvestJob({
                  HarvestJobName: job.HarvestJobName,
                }).pipe(
                  Effect.map(() => true),
                  Effect.catchTag("ConflictException", () =>
                    Effect.succeed(false),
                  ),
                );
                return {
                  created: true,
                  status: Status as string | undefined,
                  cancelled,
                  tag: undefined as string | undefined,
                };
              }),
            ),
            Effect.catchTag(["ValidationException", "ConflictException"], (e) =>
              Effect.succeed({
                created: false,
                status: undefined as string | undefined,
                cancelled: false,
                tag: e._tag as string | undefined,
              }),
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
        Lambda.EventSource,
        MediaPackageV2.ResetChannelStateHttp,
        MediaPackageV2.ResetOriginEndpointStateHttp,
        MediaPackageV2.CreateHarvestJobHttp,
        MediaPackageV2.GetHarvestJobHttp,
        MediaPackageV2.CancelHarvestJobHttp,
        MediaPackageV2.ListHarvestJobsHttp,
      ),
    ),
  ),
);
