import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import PollyTestFunctionLive, {
  BUCKET,
  LEXICON_NAME,
  PollyTestFunction,
} from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PollyBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation). Retry only 5xx; a genuine 4xx/assertion
// failure surfaces immediately.
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
        Schedule.exponential("2 seconds"),
        Schedule.recurs(5),
      ]),
    }),
  );

describe.sequential("Polly Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Polly test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Polly test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* PollyTestFunction;
        }).pipe(Effect.provide(PollyTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/ping`;
      yield* Effect.logInfo(
        `Polly test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Polly test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 180_000,
  });

  describe("DescribeVoices", () => {
    test.provider(
      "lists en-US voices including Joanna",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/voices`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            count: number;
            voiceIds: string[];
          };

          expect(response.error).toBeUndefined();
          expect(response.count).toBeGreaterThan(0);
          expect(response.voiceIds).toContain("Joanna");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListLexicons", () => {
    test.provider(
      "lists the fixture's deployed lexicon",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/lexicons`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            names: string[];
          };

          expect(response.error).toBeUndefined();
          expect(response.names).toContain(LEXICON_NAME);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetLexicon", () => {
    test.provider(
      "reads the lexicon's PLS content scoped to its ARN",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/lexicon-content`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            name: string | null;
            containsAlias: boolean;
            lexemesCount: number | null;
          };

          expect(response.error).toBeUndefined();
          expect(response.name).toBe(LEXICON_NAME);
          expect(response.containsAlias).toBe(true);
          expect(response.lexemesCount).toBe(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("StartSpeechSynthesisStream", () => {
    // skipIf-gated: the distilled HTTP transport cannot send an input event
    // stream (bidirectional streaming). A direct probe of
    // `polly.startSpeechSynthesisStream` with a finite
    // `Stream.make({ TextEvent }, { CloseStreamEvent })` ActionStream never
    // receives response headers — it hangs until `Effect.timeout` fires
    // (`TimeoutError` after 20s locally; the Lambda route hangs to the
    // test timeout). Same transport gap leaves transcribe-streaming and
    // lex StartConversation unbound fleet-wide. Re-enable with
    // AWS_TEST_POLLY_STREAM=1 once distilled core supports bidirectional
    // event-stream request bodies.
    test.provider.skipIf(!process.env.AWS_TEST_POLLY_STREAM)(
      "streams text events in and collects audio events out",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/stream`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            events: number;
            audioBytes: number;
            closed: boolean;
          };

          expect(response.error).toBeUndefined();
          expect(response.events).toBeGreaterThan(0);
          expect(response.audioBytes).toBeGreaterThan(1000);
          expect(response.closed).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("SynthesizeSpeech", () => {
    test.provider(
      "synthesizes text with the lexicon applied to non-empty mp3 bytes",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/synthesize`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            contentType?: string;
            byteLength: number;
          };

          expect(response.error).toBeUndefined();
          expect(response.contentType).toContain("audio/mpeg");
          expect(response.byteLength).toBeGreaterThan(1000);
        }),
      { timeout: 120_000 },
    );
  });

  describe("StartSpeechSynthesisTask + GetSpeechSynthesisTask + ListSpeechSynthesisTasks", () => {
    test.provider(
      "runs an async synthesis task to completion in S3",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/task`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            taskId: string;
            status: string | null;
            statusReason: string | null;
            outputUri: string | null;
            listedCount: number;
          };

          expect(response.error).toBeUndefined();
          expect(response.taskId).toBeTruthy();
          expect(response.status).toBe("completed");
          expect(response.outputUri).toContain(BUCKET);
          expect(response.listedCount).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });
});
