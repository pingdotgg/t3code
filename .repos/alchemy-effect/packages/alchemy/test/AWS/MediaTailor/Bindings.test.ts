import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import MediaTailorTestFunctionLive, {
  MediaTailorTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MediaTailorBindings");

const PREFETCH_NAME = "alchemy-test-prefetch-schedule";

let baseUrl: string;
let configName: string | undefined;
let configArn: string | undefined;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx (cold
// re-init, IAM propagation on the freshly attached policy). Retry only 5xx.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

// The fixture's IAM policies are attached moments before the first request;
// IAM propagation surfaces as a typed AccessDeniedException in the JSON body.
// Repeat (bounded) until the grant has propagated.
const untilAuthorized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (body): boolean =>
        (body as { error?: string }).error !== "AccessDeniedException",
      times: 20,
    }),
  );

const getJson = (path: string) =>
  untilAuthorized(
    send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
      Effect.flatMap((r) => r.json),
    ),
  );

const postJson = (path: string, body: object) =>
  untilAuthorized(
    send(
      HttpClientRequest.post(`${baseUrl}${path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    ).pipe(Effect.flatMap((r) => r.json)),
  );

// Out-of-band: find the playback configuration the fixture deployed (its
// physical name is generated) by its alchemy ownership tags. Runs inside
// `test.provider` so distilled has credentials; memoized across tests.
const resolveConfig = Effect.gen(function* () {
  if (configName !== undefined) return;
  const configs = yield* mediatailor.listPlaybackConfigurations
    .items({})
    .pipe(Stream.runCollect);
  const config = Array.from(configs).find(
    (candidate) =>
      candidate.Tags?.["alchemy::id"] === "BindingsConfig" &&
      candidate.Tags?.["alchemy::stack"] === "MediaTailorBindings",
  );
  expect(config).toBeDefined();
  configName = config!.Name!;
  configArn = config!.PlaybackConfigurationArn!;
});

describe.sequential("MediaTailor Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "MediaTailor test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("MediaTailor test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MediaTailorTestFunction;
        }).pipe(Effect.provide(MediaTailorTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds (sometimes over a
      // minute) to serve 200s.
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("CreatePrefetchSchedule + GetPrefetchSchedule + ListPrefetchSchedules + DeletePrefetchSchedule", () => {
    test.provider(
      "full prefetch-schedule lifecycle against the deployed configuration",
      () =>
        Effect.gen(function* () {
          yield* resolveConfig;

          // pre-clean: a previous partial run may have left the schedule
          yield* postJson("/prefetch/delete", { name: PREFETCH_NAME });

          // create
          const created = (yield* postJson("/prefetch/create", {
            name: PREFETCH_NAME,
          })) as { arn?: string; error?: string; detail?: string };
          expect(created.error, created.detail).toBeUndefined();
          expect(created.arn).toContain(":prefetchSchedule/");

          // out-of-band verification via distilled
          const fetched = yield* mediatailor.getPrefetchSchedule({
            Name: PREFETCH_NAME,
            PlaybackConfigurationName: configName!,
          });
          expect(fetched.Name).toBe(PREFETCH_NAME);

          // get through the binding
          const got = (yield* getJson(
            `/prefetch/get?name=${PREFETCH_NAME}`,
          )) as { name?: string; error?: string; detail?: string };
          expect(got.error, got.detail).toBeUndefined();
          expect(got.name).toBe(PREFETCH_NAME);

          // list through the binding
          const listed = (yield* getJson("/prefetch/list")) as {
            names: string[];
            error?: string;
            detail?: string;
          };
          expect(listed.error, listed.detail).toBeUndefined();
          expect(listed.names).toContain(PREFETCH_NAME);

          // delete through the binding
          const deleted = (yield* postJson("/prefetch/delete", {
            name: PREFETCH_NAME,
          })) as { deleted: boolean; error?: string; detail?: string };
          expect(deleted.error, deleted.detail).toBeUndefined();
          expect(deleted.deleted).toBe(true);

          // get after delete surfaces the typed synthetic tag
          const gone = (yield* getJson(
            `/prefetch/get?name=${PREFETCH_NAME}`,
          )) as { name?: string; error?: string };
          expect(gone.error).toBe("PrefetchScheduleNotFound");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListAlerts", () => {
    test.provider(
      "rejects a non-channel-assembly ARN with the typed BadRequestException",
      () =>
        Effect.gen(function* () {
          yield* resolveConfig;

          // ListAlerts only accepts channel-assembly resource ARNs; a
          // playback-configuration ARN is rejected with the typed
          // BadRequestException (never AccessDenied — proving the
          // mediatailor:ListAlerts grant reached the API).
          const body = (yield* getJson(
            `/alerts?arn=${encodeURIComponent(configArn!)}`,
          )) as { count: number; error?: string; detail?: string };
          expect(body.error, body.detail).toBe("BadRequestException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetChannelSchedule", () => {
    test.provider(
      "returns the typed ChannelNotFound for a missing channel",
      () =>
        Effect.gen(function* () {
          const body = (yield* getJson(
            "/channel/schedule?name=alchemy-nonexistent-mediatailor-channel",
          )) as { count: number; error?: string; detail?: string };
          // A typed not-found (never AccessDenied) proves the
          // mediatailor:GetChannelSchedule grant reached the API.
          expect(body.error, body.detail).toBe("ChannelNotFound");
        }),
      { timeout: 120_000 },
    );
  });

  describe("StartChannel + StopChannel", () => {
    test.provider(
      "start/stop of a missing channel fail with typed tags (never AccessDenied)",
      () =>
        Effect.gen(function* () {
          const started = (yield* postJson("/channel/start", {
            name: "alchemy-nonexistent-mediatailor-channel",
          })) as { started: boolean; error?: string; detail?: string };
          expect(started.started).toBe(false);
          expect(
            ["ChannelNotFound", "BadRequestException"],
            started.detail,
          ).toContain(started.error);

          const stopped = (yield* postJson("/channel/stop", {
            name: "alchemy-nonexistent-mediatailor-channel",
          })) as { stopped: boolean; error?: string; detail?: string };
          expect(stopped.stopped).toBe(false);
          expect(
            ["ChannelNotFound", "BadRequestException"],
            stopped.detail,
          ).toContain(stopped.error);
        }),
      { timeout: 120_000 },
    );
  });

  describe("CreateProgram + DescribeProgram + UpdateProgram + DeleteProgram", () => {
    test.provider(
      "program operations on a missing channel fail with typed tags (never AccessDenied)",
      () =>
        Effect.gen(function* () {
          const created = (yield* postJson("/program/create", {})) as {
            created: boolean;
            error?: string;
            detail?: string;
          };
          expect(created.created).toBe(false);
          expect(
            ["ChannelNotFound", "BadRequestException"],
            created.detail,
          ).toContain(created.error);

          const described = (yield* getJson("/program")) as {
            name?: string;
            error?: string;
            detail?: string;
          };
          expect(described.name).toBeUndefined();
          expect(
            ["ProgramNotFound", "BadRequestException"],
            described.detail,
          ).toContain(described.error);

          const updated = (yield* postJson("/program/update", {})) as {
            updated: boolean;
            error?: string;
            detail?: string;
          };
          expect(updated.updated).toBe(false);
          expect(
            ["ProgramNotFound", "BadRequestException"],
            updated.detail,
          ).toContain(updated.error);

          const deleted = (yield* postJson("/program/delete", {})) as {
            deleted: boolean;
            error?: string;
            detail?: string;
          };
          expect(deleted.deleted).toBe(false);
          expect(
            ["ProgramNotFound", "BadRequestException"],
            deleted.detail,
          ).toContain(deleted.error);
        }),
      { timeout: 120_000 },
    );
  });
});
