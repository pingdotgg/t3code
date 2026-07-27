import * as AWS from "@/AWS";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Deterministic bucket for async synthesis output. Polly writes the audio
// with the CALLER's credentials, so the Lambda role is granted s3:PutObject
// on it via the AWS.S3.PutObject binding below.
export const BUCKET = "alchemy-test-polly-bindings";

// Lexicon names must match [0-9A-Za-z]{1,20} — exactly 20 characters.
export const LEXICON_NAME = "alchemyPollyBindings";

/** Checked-in W3C PLS document (never generated at test time). */
export const PLS_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<lexicon version="1.0"
      xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"
      alphabet="ipa" xml:lang="en-US">
  <lexeme><grapheme>IaE</grapheme><alias>infrastructure as effects</alias></lexeme>
</lexicon>`;

export const SPEECH_TEXT = "Alchemy turns IaE into deployed infrastructure.";

export class PollyTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "PollyTestFunction",
) {}

/**
 * Shared infrastructure for the Polly bindings fixture: the async-synthesis
 * output bucket and the pronunciation lexicon the routes reference by name.
 */
export class PollyFixtures extends Context.Service<
  PollyFixtures,
  {
    bucket: AWS.S3.Bucket;
    lexicon: AWS.Polly.Lexicon;
  }
>()("PollyFixtures") {}

export const PollyFixturesLive = Layer.effect(
  PollyFixtures,
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("PollyTaskOutput", {
      bucketName: BUCKET,
      forceDestroy: true,
    });
    const lexicon = yield* AWS.Polly.Lexicon("BindingsLexicon", {
      lexiconName: LEXICON_NAME,
      content: PLS_CONTENT,
    });
    return { bucket, lexicon };
  }),
);

export default PollyTestFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.minutes(2),
  },
  Effect.gen(function* () {
    const { bucket, lexicon } = yield* PollyFixtures;

    // --- bindings under test ---
    const describeVoices = yield* AWS.Polly.DescribeVoices();
    const listLexicons = yield* AWS.Polly.ListLexicons();
    const getLexicon = yield* AWS.Polly.GetLexicon(lexicon);
    const synthesizeSpeech = yield* AWS.Polly.SynthesizeSpeech();
    const startSpeechSynthesisTask =
      yield* AWS.Polly.StartSpeechSynthesisTask();
    const getSpeechSynthesisTask = yield* AWS.Polly.GetSpeechSynthesisTask();
    const listSpeechSynthesisTasks =
      yield* AWS.Polly.ListSpeechSynthesisTasks();
    const startSpeechSynthesisStream =
      yield* AWS.Polly.StartSpeechSynthesisStream();
    // Grants the Lambda role s3:PutObject on the output bucket — Polly
    // writes the async synthesis result with the caller's credentials.
    yield* AWS.S3.PutObject(bucket);

    const bound = {
      describeVoices,
      listLexicons,
      getLexicon,
      synthesizeSpeech,
      startSpeechSynthesisTask,
      getSpeechSynthesisTask,
      listSpeechSynthesisTasks,
      startSpeechSynthesisStream,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({
            ok: true,
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/voices") {
          const result = yield* describeVoices({ LanguageCode: "en-US" });
          return yield* HttpServerResponse.json({
            count: (result.Voices ?? []).length,
            voiceIds: (result.Voices ?? []).map((voice) => voice.Id),
          });
        }

        if (request.method === "GET" && pathname === "/lexicons") {
          const result = yield* listLexicons();
          return yield* HttpServerResponse.json({
            names: (result.Lexicons ?? []).flatMap((lexicon) =>
              lexicon.Name ? [lexicon.Name] : [],
            ),
          });
        }

        if (request.method === "GET" && pathname === "/lexicon-content") {
          const result = yield* getLexicon();
          const content = result.Lexicon?.Content;
          const xml =
            content === undefined
              ? undefined
              : Redacted.isRedacted(content)
                ? Redacted.value(content)
                : content;
          return yield* HttpServerResponse.json({
            name: result.Lexicon?.Name ?? null,
            containsAlias: xml?.includes("infrastructure as effects") ?? false,
            lexemesCount: result.LexiconAttributes?.LexemesCount ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/stream") {
          const result = yield* startSpeechSynthesisStream({
            Engine: "generative",
            OutputFormat: "mp3",
            VoiceId: "Matthew",
            ActionStream: Stream.make(
              { TextEvent: { Text: SPEECH_TEXT } },
              { CloseStreamEvent: {} },
            ),
          });
          const events = Array.from(
            yield* Stream.runCollect(result.EventStream!),
          );
          const audioBytes = events.reduce(
            (total, event) =>
              total + (event.AudioEvent?.AudioChunk?.length ?? 0),
            0,
          );
          return yield* HttpServerResponse.json({
            events: events.length,
            audioBytes,
            closed: events.some(
              (event) => event.StreamClosedEvent !== undefined,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/synthesize") {
          const result = yield* synthesizeSpeech({
            Engine: "neural",
            OutputFormat: "mp3",
            VoiceId: "Joanna",
            Text: SPEECH_TEXT,
            LexiconNames: [LEXICON_NAME],
          });
          const chunks = yield* Stream.runCollect(result.AudioStream!);
          const byteLength = Array.from(chunks).reduce(
            (total, chunk) => total + chunk.length,
            0,
          );
          return yield* HttpServerResponse.json({
            contentType: result.ContentType,
            byteLength,
          });
        }

        if (request.method === "POST" && pathname === "/task") {
          const started = yield* startSpeechSynthesisTask({
            Engine: "neural",
            OutputFormat: "mp3",
            OutputS3BucketName: BUCKET,
            OutputS3KeyPrefix: "task-output/",
            VoiceId: "Joanna",
            Text: SPEECH_TEXT,
          });
          const taskId = started.SynthesisTask?.TaskId!;

          // A freshly started task can briefly 404; retry the typed tag,
          // then poll (bounded) until the task leaves the queue.
          const task = yield* getSpeechSynthesisTask({ TaskId: taskId }).pipe(
            Effect.retry({
              while: (e) => e._tag === "SynthesisTaskNotFoundException",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(5),
              ]),
            }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean =>
                r.SynthesisTask?.TaskStatus === "completed" ||
                r.SynthesisTask?.TaskStatus === "failed",
              times: 25,
            }),
          );

          const listed = yield* listSpeechSynthesisTasks({ MaxResults: 10 });

          return yield* HttpServerResponse.json({
            taskId,
            status: task.SynthesisTask?.TaskStatus ?? null,
            statusReason: task.SynthesisTask?.TaskStatusReason ?? null,
            outputUri: task.SynthesisTask?.OutputUri ?? null,
            listedCount: (listed.SynthesisTasks ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface every failure (typed error or defect) to the test as JSON
        // instead of an opaque 500 — the test asserts `error` is absent.
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Polly.DescribeVoicesHttp,
        AWS.Polly.ListLexiconsHttp,
        AWS.Polly.GetLexiconHttp,
        AWS.Polly.SynthesizeSpeechHttp,
        AWS.Polly.StartSpeechSynthesisTaskHttp,
        AWS.Polly.GetSpeechSynthesisTaskHttp,
        AWS.Polly.ListSpeechSynthesisTasksHttp,
        AWS.Polly.StartSpeechSynthesisStreamHttp,
        AWS.S3.PutObjectHttp,
        PollyFixturesLive,
      ),
    ),
  ),
);
