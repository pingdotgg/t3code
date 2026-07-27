import * as Lambda from "@/AWS/Lambda";
import * as MediaTailor from "@/AWS/MediaTailor";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Channel-assembly names are runtime request parameters; these nonexistent
// names drive the typed not-found paths (proving the IAM grants reached the
// API — a missing grant would surface AccessDeniedException instead).
export const NONEXISTENT_CHANNEL = "alchemy-nonexistent-mediatailor-channel";
export const NONEXISTENT_PROGRAM = "alchemy-nonexistent-mediatailor-program";

export class MediaTailorTestFunction extends Lambda.Function<Lambda.Function>()(
  "MediaTailorTestFunction",
) {}

export default MediaTailorTestFunction.make(
  {
    main,
    url: true,
    // MediaTailor control-plane calls routinely take a few seconds; AWS's
    // default 3s Lambda timeout is too tight under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const config = yield* MediaTailor.PlaybackConfiguration("BindingsConfig", {
      adDecisionServerUrl: "https://ads.example.com/vast?ip=[client_ip]",
      videoContentSourceUrl: "https://origin.example.com/live",
    });

    const createPrefetchSchedule =
      yield* MediaTailor.CreatePrefetchSchedule(config);
    const getPrefetchSchedule = yield* MediaTailor.GetPrefetchSchedule(config);
    const deletePrefetchSchedule =
      yield* MediaTailor.DeletePrefetchSchedule(config);
    const listPrefetchSchedules =
      yield* MediaTailor.ListPrefetchSchedules(config);
    const listAlerts = yield* MediaTailor.ListAlerts();
    const getChannelSchedule = yield* MediaTailor.GetChannelSchedule();
    const startChannel = yield* MediaTailor.StartChannel();
    const stopChannel = yield* MediaTailor.StopChannel();
    const createProgram = yield* MediaTailor.CreateProgram();
    const describeProgram = yield* MediaTailor.DescribeProgram();
    const updateProgram = yield* MediaTailor.UpdateProgram();
    const deleteProgram = yield* MediaTailor.DeleteProgram();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/prefetch/create") {
          const body = (yield* request.json) as unknown as { name: string };
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* createPrefetchSchedule({
            Name: body.name,
            Retrieval: { EndTime: new Date(now + 60 * 60 * 1000) },
            Consumption: { EndTime: new Date(now + 2 * 60 * 60 * 1000) },
          }).pipe(
            Effect.map((r) => ({
              arn: r.Arn,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                arn: undefined,
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/prefetch/get") {
          const name = url.searchParams.get("name")!;
          const result = yield* getPrefetchSchedule({ Name: name }).pipe(
            Effect.map((r) => ({
              name: r.Name,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                name: undefined,
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/prefetch/list") {
          const result = yield* listPrefetchSchedules({}).pipe(
            Effect.map((r) => ({
              names: (r.Items ?? []).map((item) => item.Name),
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                names: [] as string[],
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/prefetch/delete") {
          const body = (yield* request.json) as unknown as { name: string };
          const result = yield* deletePrefetchSchedule({
            Name: body.name,
          }).pipe(
            Effect.map(() => ({
              deleted: true,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                deleted: false,
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/alerts") {
          const arn = url.searchParams.get("arn")!;
          const result = yield* listAlerts({ ResourceArn: arn }).pipe(
            Effect.map((r) => ({
              count: r.Items?.length ?? 0,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({ count: 0, error: e._tag, detail: String(e) }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/channel/schedule") {
          const name = url.searchParams.get("name")!;
          const result = yield* getChannelSchedule({ ChannelName: name }).pipe(
            Effect.map((r) => ({
              count: r.Items?.length ?? 0,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({ count: 0, error: e._tag, detail: String(e) }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/channel/start") {
          const body = (yield* request.json) as unknown as { name: string };
          const result = yield* startChannel({ ChannelName: body.name }).pipe(
            Effect.map(() => ({
              started: true,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                started: false,
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/channel/stop") {
          const body = (yield* request.json) as unknown as { name: string };
          const result = yield* stopChannel({ ChannelName: body.name }).pipe(
            Effect.map(() => ({
              stopped: true,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                stopped: false,
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/program/create") {
          const result = yield* createProgram({
            ChannelName: NONEXISTENT_CHANNEL,
            ProgramName: NONEXISTENT_PROGRAM,
            SourceLocationName: "alchemy-nonexistent-source-location",
            VodSourceName: "alchemy-nonexistent-vod-source",
            ScheduleConfiguration: {
              Transition: {
                Type: "RELATIVE",
                RelativePosition: "AFTER_PROGRAM",
              },
            },
          }).pipe(
            Effect.map(() => ({
              created: true,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                created: false,
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/program") {
          const result = yield* describeProgram({
            ChannelName: NONEXISTENT_CHANNEL,
            ProgramName: NONEXISTENT_PROGRAM,
          }).pipe(
            Effect.map((r) => ({
              name: r.ProgramName,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                name: undefined,
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/program/update") {
          const result = yield* updateProgram({
            ChannelName: NONEXISTENT_CHANNEL,
            ProgramName: NONEXISTENT_PROGRAM,
            ScheduleConfiguration: {},
          }).pipe(
            Effect.map(() => ({
              updated: true,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                updated: false,
                error: e._tag,
                detail: String(e),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/program/delete") {
          const result = yield* deleteProgram({
            ChannelName: NONEXISTENT_CHANNEL,
            ProgramName: NONEXISTENT_PROGRAM,
          }).pipe(
            Effect.map(() => ({
              deleted: true,
              error: undefined,
              detail: undefined,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                deleted: false,
                error: e._tag,
                detail: String(e),
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
        MediaTailor.CreatePrefetchScheduleHttp,
        MediaTailor.GetPrefetchScheduleHttp,
        MediaTailor.DeletePrefetchScheduleHttp,
        MediaTailor.ListPrefetchSchedulesHttp,
        MediaTailor.ListAlertsHttp,
        MediaTailor.GetChannelScheduleHttp,
        MediaTailor.StartChannelHttp,
        MediaTailor.StopChannelHttp,
        MediaTailor.CreateProgramHttp,
        MediaTailor.DescribeProgramHttp,
        MediaTailor.UpdateProgramHttp,
        MediaTailor.DeleteProgramHttp,
      ),
    ),
  ),
);
