import * as Lambda from "@/AWS/Lambda";
import * as MediaConvert from "@/AWS/MediaConvert";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class MediaConvertTestFunction extends Lambda.Function<Lambda.Function>()(
  "MediaConvertTestFunction",
) {}

export default MediaConvertTestFunction.make(
  {
    main,
    url: true,
    // MediaConvert control-plane calls routinely take a few seconds; AWS's
    // default 3s Lambda timeout is too tight under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const createJob = yield* MediaConvert.CreateJob();
    const getJob = yield* MediaConvert.GetJob();
    const cancelJob = yield* MediaConvert.CancelJob();
    const listJobs = yield* MediaConvert.ListJobs();
    const searchJobs = yield* MediaConvert.SearchJobs();
    const probe = yield* MediaConvert.Probe();
    const startJobsQuery = yield* MediaConvert.StartJobsQuery();
    const getJobsQueryResults = yield* MediaConvert.GetJobsQueryResults();

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.mediaconvert) targeting this Function. The test verifies the rule
    // deploys; runtime firing would require a billable transcode.
    yield* MediaConvert.consumeJobEvents(
      { statuses: ["COMPLETE", "ERROR"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `mediaconvert job event: ${event.detail.jobId} -> ${event.detail.status}`,
          ),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/jobs") {
          const result = yield* listJobs({ MaxResults: 5 });
          return yield* HttpServerResponse.json({
            count: result.Jobs?.length ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/search") {
          const result = yield* searchJobs({
            Status: "COMPLETE",
            MaxResults: 5,
          });
          return yield* HttpServerResponse.json({
            count: result.Jobs?.length ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/job") {
          const id = url.searchParams.get("id")!;
          const result = yield* getJob({ Id: id }).pipe(
            Effect.map((r) => ({ status: r.Job?.Status, error: undefined })),
            Effect.catch((e) =>
              Effect.succeed({ status: undefined, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/cancel") {
          const body = (yield* request.json) as unknown as { id: string };
          const result = yield* cancelJob({ Id: body.id }).pipe(
            Effect.map(() => ({ cancelled: true, error: undefined })),
            Effect.catch((e) =>
              Effect.succeed({ cancelled: false, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/probe") {
          const body = (yield* request.json) as unknown as { fileUrl: string };
          const result = yield* probe({
            InputFiles: [{ FileUrl: body.fileUrl }],
          }).pipe(
            Effect.map((r) => ({
              probed: (r.ProbeResults?.length ?? 0) > 0,
              error: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({ probed: false, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/submit") {
          const body = (yield* request.json) as unknown as { role: string };
          const result = yield* createJob({
            Role: body.role,
            Settings: {
              Inputs: [{ FileInput: "s3://alchemy-nonexistent/in.mp4" }],
              OutputGroups: [
                {
                  Name: "File Group",
                  OutputGroupSettings: {
                    Type: "FILE_GROUP_SETTINGS",
                    FileGroupSettings: {
                      Destination: "s3://alchemy-nonexistent/out/",
                    },
                  },
                  Outputs: [
                    {
                      ContainerSettings: { Container: "MP4", Mp4Settings: {} },
                      VideoDescription: {
                        CodecSettings: {
                          Codec: "H_264",
                          H264Settings: {
                            RateControlMode: "QVBR",
                            MaxBitrate: 3000000,
                          },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          }).pipe(
            Effect.map((r) => ({ jobId: r.Job?.Id, error: undefined })),
            Effect.catch((e) =>
              Effect.succeed({ jobId: undefined, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/jobsQuery") {
          const result = yield* startJobsQuery({ MaxResults: 5 }).pipe(
            Effect.map((r) => ({ queryId: r.Id, error: undefined })),
            Effect.catch((e) =>
              Effect.succeed({ queryId: undefined, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/jobsQueryResults") {
          const id = url.searchParams.get("id")!;
          const result = yield* getJobsQueryResults({ Id: id }).pipe(
            Effect.map((r) => ({
              status: r.Status,
              count: r.Jobs?.length ?? 0,
              error: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({ status: undefined, count: 0, error: e._tag }),
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
        MediaConvert.CreateJobHttp,
        MediaConvert.GetJobHttp,
        MediaConvert.CancelJobHttp,
        MediaConvert.ListJobsHttp,
        MediaConvert.SearchJobsHttp,
        MediaConvert.ProbeHttp,
        MediaConvert.StartJobsQueryHttp,
        MediaConvert.GetJobsQueryResultsHttp,
      ),
    ),
  ),
);
