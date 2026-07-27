import * as Comprehend from "@/AWS/Comprehend";
import * as Lambda from "@/AWS/Lambda";
import * as Polly from "@/AWS/Polly";
import * as Rekognition from "@/AWS/Rekognition";
import * as Textract from "@/AWS/Textract";
import * as Translate from "@/AWS/Translate";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import {
  HELLO_PNG_BASE64,
  SENTIMENT_TEXT,
  SPEECH_TEXT,
  TRANSLATE_TEXT,
} from "./constants.ts";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic checked-in test input, decoded once at module init.
const HELLO_PNG_BYTES = Buffer.from(HELLO_PNG_BASE64, "base64");

export class AICapabilitiesTestFunction extends Lambda.Function<Lambda.Function>()(
  "AICapabilitiesTestFunction",
) {}

export default AICapabilitiesTestFunction.make(
  {
    main,
    url: true,
    // Vision/speech inference regularly exceeds Lambda's 3s default timeout.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const detectLabels = yield* Rekognition.DetectLabels();
    const detectDocumentText = yield* Textract.DetectDocumentText();
    const synthesizeSpeech = yield* Polly.SynthesizeSpeech();
    const translateText = yield* Translate.TranslateText();
    const detectSentiment = yield* Comprehend.DetectSentiment();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/detect-labels") {
          const result = yield* detectLabels({
            Image: { Bytes: HELLO_PNG_BYTES },
            MaxLabels: 10,
            MinConfidence: 50,
          });
          return yield* HttpServerResponse.json({
            labels: (result.Labels ?? []).map((label) => label.Name),
            labelModelVersion: result.LabelModelVersion,
          });
        }

        if (request.method === "GET" && pathname === "/detect-document-text") {
          const result = yield* detectDocumentText({
            Document: { Bytes: HELLO_PNG_BYTES },
          });
          return yield* HttpServerResponse.json({
            lines: (result.Blocks ?? [])
              .filter((block) => block.BlockType === "LINE")
              .map((block) => block.Text),
            pages: result.DocumentMetadata?.Pages,
          });
        }

        if (request.method === "GET" && pathname === "/synthesize-speech") {
          const result = yield* synthesizeSpeech({
            Engine: "neural",
            OutputFormat: "mp3",
            VoiceId: "Joanna",
            Text: SPEECH_TEXT,
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

        if (request.method === "GET" && pathname === "/translate-text") {
          const result = yield* translateText({
            Text: TRANSLATE_TEXT,
            SourceLanguageCode: "en",
            TargetLanguageCode: "es",
          });
          return yield* HttpServerResponse.json({
            translatedText: result.TranslatedText,
            sourceLanguageCode: result.SourceLanguageCode,
            targetLanguageCode: result.TargetLanguageCode,
          });
        }

        if (request.method === "GET" && pathname === "/detect-sentiment") {
          const result = yield* detectSentiment({
            Text: SENTIMENT_TEXT,
            LanguageCode: "en",
          });
          return yield* HttpServerResponse.json({
            sentiment: result.Sentiment,
            sentimentScore: result.SentimentScore,
          });
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
        Rekognition.DetectLabelsHttp,
        Textract.DetectDocumentTextHttp,
        Polly.SynthesizeSpeechHttp,
        Translate.TranslateTextHttp,
        Comprehend.DetectSentimentHttp,
      ),
    ),
  ),
);
