import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import KinesisVideoTestFunctionLive, {
  KinesisVideoTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "KinesisVideoBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class FixtureStillExists extends Data.TaggedError("FixtureStillExists")<{
  readonly streams: string[];
  readonly channels: string[];
}> {}

// Retry transient 5xx from the shared fixture under parallel-suite load;
// genuine 4xx failures surface immediately.
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
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

// The fixture's role policies are freshly created on every deploy, and IAM
// is eventually consistent — the first data-plane calls can transiently
// return AccessDeniedException. Fetch the route's JSON outcome and repeat
// (bounded) until propagation settles on the terminal typed tag.
const fetchOutcome = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? (response.json as Effect.Effect<unknown>)
        : Effect.fail(
            new TransientUpstream({ status: response.status, body: "" }),
          ),
    ),
    Effect.map(
      (body) =>
        body as {
          ok?: boolean;
          count?: number;
          url?: string;
          contentType?: string;
          timedOut?: boolean;
          answered?: boolean;
          errorTag?: string;
          errorMessage?: string;
        },
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (body): boolean => body.errorTag !== "AccessDeniedException",
      times: 20,
    }),
  );

describe("KinesisVideo Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "KinesisVideo test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("KinesisVideo test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* KinesisVideoTestFunction;
        }).pipe(Effect.provide(KinesisVideoTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `KinesisVideo test setup: probing readiness at ${baseUrl}/info`,
      );
      yield* HttpClient.get(`${baseUrl}/info`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.void
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // assert the fixture stream + channel are gone out-of-band. Physical
      // names are deterministic: `${stackName}-${logicalId}-${stage}-…`, so a
      // BEGINS_WITH listing pinpoints exactly the resources this suite owns.
      // Deletion is asynchronous — DELETING counts as gone.
      yield* Effect.gen(function* () {
        const streams = yield* kv.listStreams({
          StreamNameCondition: {
            ComparisonOperator: "BEGINS_WITH",
            ComparisonValue: "KinesisVideoBindings-FixtureStream-test-",
          },
        });
        const liveStreams = (streams.StreamInfoList ?? []).filter(
          (s) => s.Status !== "DELETING",
        );
        const channels = yield* kv.listSignalingChannels({
          ChannelNameCondition: {
            ComparisonOperator: "BEGINS_WITH",
            ComparisonValue: "KinesisVideoBindings-FixtureChannel-test-",
          },
        });
        const liveChannels = (channels.ChannelInfoList ?? []).filter(
          (c) => c.ChannelStatus !== "DELETING",
        );
        if (liveStreams.length > 0 || liveChannels.length > 0) {
          return yield* Effect.fail(
            new FixtureStillExists({
              streams: liveStreams.map((s) => s.StreamName ?? "?"),
              channels: liveChannels.map((c) => c.ChannelName ?? "?"),
            }),
          );
        }
      }).pipe(
        Effect.retry({
          while: (e): boolean => e._tag === "FixtureStillExists",
          schedule: Schedule.max([
            Schedule.spaced("3 seconds"),
            Schedule.recurs(10),
          ]),
        }),
        (effect) =>
          Core.withProviders(effect, testOptions, "KinesisVideoBindings"),
      );
    }),
    {
      timeout: 240_000,
    },
  );

  describe("GetHLSStreamingSessionURL", () => {
    test.provider(
      "lambda reaches the archived-media data plane through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/hls`);
          // The fixture stream has never ingested media, so LIVE playback
          // deterministically returns the archived-media data plane's typed
          // no-fragments error. Getting THIS tag (and not NotAuthorized /
          // an unknown error) proves GetDataEndpoint resolution, IAM, and
          // the signed data-plane call all work.
          expect(body.errorTag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetIceServerConfig", () => {
    test.provider(
      "lambda fetches TURN servers through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(HttpClientRequest.get(`${baseUrl}/ice`));
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            servers?: {
              uris: string[];
              hasCredentials: boolean;
              ttl?: number;
            }[];
            errorTag?: string;
          };
          expect(body.errorTag).toBeUndefined();
          expect(body.servers!.length).toBeGreaterThan(0);
          const turn = body.servers!.find((s) =>
            s.uris.some((uri) => uri.startsWith("turn")),
          );
          expect(turn).toBeDefined();
          expect(turn?.hasCredentials).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetDASHStreamingSessionURL", () => {
    test.provider(
      "lambda reaches the archived-media data plane through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/dash`);
          // Same rationale as /hls: LIVE playback on the never-ingested
          // stream returns the typed no-fragments error.
          expect(body.errorTag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListFragments", () => {
    test.provider(
      "lambda lists fragments of the empty stream (empty page)",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/fragments`);
          // toMatchObject so a failure diff surfaces the errorTag
          expect(body).toMatchObject({ ok: true, count: 0 });
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetClip", () => {
    test.provider(
      "lambda requests a clip and receives the typed no-fragments error",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/clip`);
          expect(body.ok).toBe(false);
          expect(body.errorTag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetImages", () => {
    test.provider(
      "lambda extracts images from the empty stream (empty page or typed error)",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/images`);
          // The empty stream always rejects the request with a typed error;
          // WHICH tag is a function of the seconds-old stream's age: while
          // the trailing-60s window still predates the stream's creation the
          // service answers InvalidArgumentException ("End timestamp … is
          // outside of the stream retention period"), and once the window
          // overlaps its lifetime it answers ResourceNotFoundException
          // ("No fragments found"). Both are data-plane responses, proving
          // endpoint discovery, IAM, and the signed call.
          expect(body.ok).toBe(false);
          expect([
            "ResourceNotFoundException",
            "InvalidArgumentException",
          ]).toContain(body.errorTag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetMediaForFragmentList", () => {
    test.provider(
      "lambda requests fragment media and receives the typed no-fragment error",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/fragment-media`);
          // The nonexistent fragment number is deterministically rejected by
          // the media data plane: "Fragment numbers are invalid".
          expect(body.ok).toBe(false);
          expect(body.errorTag).toBe("InvalidArgumentException");
          expect(body.errorMessage).toContain("Fragment numbers are invalid");
        }),
      { timeout: 120_000 },
    );
  });

  describe("JoinStorageSession", () => {
    test.provider(
      "lambda reaches the WebRTC storage plane; unconfigured storage is a typed error",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/join-storage`);
          // The fixture channel has no MediaStorageConfiguration, so WEBRTC
          // endpoint discovery deterministically rejects the channel:
          // "MediaStorageConfiguration is required for WEBRTC protocol".
          expect(body.ok).toBe(false);
          expect(body.errorTag).toBe("InvalidArgumentException");
          expect(body.errorMessage).toContain("MediaStorageConfiguration");
        }),
      { timeout: 120_000 },
    );
  });

  describe("JoinStorageSessionAsViewer", () => {
    test.provider(
      "lambda reaches the WebRTC storage plane as viewer; typed error without storage",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/join-storage-viewer`);
          // Same deterministic rejection as /join-storage.
          expect(body.ok).toBe(false);
          expect(body.errorTag).toBe("InvalidArgumentException");
          expect(body.errorMessage).toContain("MediaStorageConfiguration");
        }),
      { timeout: 120_000 },
    );
  });

  describe("SendAlexaOfferToMaster", () => {
    test.provider(
      "lambda delivers an SDP offer through the signaling plane",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/alexa-offer`);
          // The signaling data plane accepts the SDP stub and, with no
          // master connected to answer, deterministically holds the offer
          // until the fixture's bounded 5s timeout.
          expect(body).toMatchObject({ ok: true, timedOut: true });
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetMedia", () => {
    test.provider(
      "lambda opens a media connection through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* fetchOutcome(`${baseUrl}/media`);
          // The media data plane deterministically accepts the connection to
          // the empty stream and answers with matroska headers before any
          // fragment exists.
          expect(body).toMatchObject({ ok: true, contentType: "video/webm" });
        }),
      { timeout: 120_000 },
    );
  });
});
