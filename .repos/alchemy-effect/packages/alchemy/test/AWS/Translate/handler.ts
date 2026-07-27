import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Translate from "@/AWS/Translate";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Deterministic fixture names (bucket names are account-global; this suite
// owns them in the testing account).
export const FIXTURE_BUCKET_NAME = "alchemy-test-translate-bindings";
export const TERMINOLOGY_NAME = "alchemy-translate-bindings-glossary";

// Checked-in CSV terminology — never generated at test time. The first row
// is the language-code header; each subsequent row is a term pair.
export const TERMINOLOGY_CSV = ["en,es", "Alchemy,Alquimia"].join("\n");

// Well-formed-but-nonexistent 32-hex-digit job id used to drive the typed
// ResourceNotFoundException paths. An IAM gap would surface
// AccessDeniedException (reported as `error` by the handler), so a typed
// not-found tag proves the grant end-to-end.
const BOGUS_JOB_ID = "00000000000000000000000000000000";

export class TranslateTestFunction extends Lambda.Function<Lambda.Function>()(
  "TranslateTestFunction",
) {}

/**
 * Shared infrastructure for the Translate bindings fixture: the batch-job
 * S3 bucket, the data-access role Translate assumes for batch jobs, and the
 * custom terminology the routes reference by name.
 */
export class TranslateFixtures extends Context.Service<
  TranslateFixtures,
  {
    bucket: S3.Bucket;
    dataAccessRole: IAM.Role;
    terminology: Translate.Terminology;
  }
>()("TranslateFixtures") {}

export const TranslateFixturesLive = Layer.effect(
  TranslateFixtures,
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("TranslateJobBucket", {
      bucketName: FIXTURE_BUCKET_NAME,
      forceDestroy: true,
    });
    // The role Amazon Translate assumes to read input documents and write
    // batch translation results.
    const dataAccessRole = yield* IAM.Role("TranslateDataAccessRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "translate.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        s3Access: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:ListBucket", "s3:PutObject"],
              Resource: [
                `arn:aws:s3:::${FIXTURE_BUCKET_NAME}`,
                `arn:aws:s3:::${FIXTURE_BUCKET_NAME}/*`,
              ],
            },
          ],
        },
      },
    });
    const terminology = yield* Translate.Terminology("BindingsGlossary", {
      terminologyName: TERMINOLOGY_NAME,
      file: TERMINOLOGY_CSV,
      format: "CSV",
    });
    return { bucket, dataAccessRole, terminology };
  }),
);

export default TranslateTestFunction.make(
  {
    main: import.meta.url,
    url: true,
    // The job lifecycle route retries StartTextTranslationJob through
    // fresh-role IAM propagation (bounded ~40s).
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const { bucket, dataAccessRole } = yield* TranslateFixtures;

    // --- bindings under test ---
    const translateText = yield* Translate.TranslateText();
    const translateDocument = yield* Translate.TranslateDocument();
    const listLanguages = yield* Translate.ListLanguages();
    const getTerminology = yield* Translate.GetTerminology();
    const listTerminologies = yield* Translate.ListTerminologies();
    const getParallelData = yield* Translate.GetParallelData();
    const listParallelData = yield* Translate.ListParallelData();
    const startTextTranslationJob =
      yield* Translate.StartTextTranslationJob(dataAccessRole);
    const describeTextTranslationJob =
      yield* Translate.DescribeTextTranslationJob();
    const stopTextTranslationJob = yield* Translate.StopTextTranslationJob();
    const listTextTranslationJobs = yield* Translate.ListTextTranslationJobs();
    const putObject = yield* S3.PutObject(bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Translate call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        // TranslateText — plain and with the fixture terminology applied.
        if (request.method === "GET" && pathname === "/translate") {
          const basic = yield* translateText({
            Text: "Hello, world!",
            SourceLanguageCode: "en",
            TargetLanguageCode: "es",
          });
          // NOTE: with "Alchemy" as the sentence-initial subject the model
          // treats it as a brand name and declines to substitute the term;
          // mid-sentence it applies reliably (verified with the raw API).
          const withTerminology = yield* translateText({
            Text: "I love Alchemy so much.",
            SourceLanguageCode: "en",
            TargetLanguageCode: "es",
            TerminologyNames: [TERMINOLOGY_NAME],
          });
          return yield* HttpServerResponse.json({
            basic: basic.TranslatedText,
            withTerminology: withTerminology.TranslatedText,
            appliedTerminologies: (
              withTerminology.AppliedTerminologies ?? []
            ).map((t) => t.Name),
          });
        }

        // TranslateDocument — plain-text document, decode the Redacted blob.
        if (request.method === "GET" && pathname === "/document") {
          const result = yield* translateDocument({
            Document: {
              Content: new TextEncoder().encode("Good morning, friend."),
              ContentType: "text/plain",
            },
            SourceLanguageCode: "en",
            TargetLanguageCode: "es",
          });
          const content = result.TranslatedDocument.Content;
          const bytes = Redacted.isRedacted(content)
            ? Redacted.value(content)
            : content;
          return yield* HttpServerResponse.json({
            translated: new TextDecoder().decode(bytes),
            sourceLanguageCode: result.SourceLanguageCode,
            targetLanguageCode: result.TargetLanguageCode,
          });
        }

        if (request.method === "GET" && pathname === "/languages") {
          const result = yield* listLanguages({ MaxResults: 500 });
          return yield* HttpServerResponse.json({
            count: (result.Languages ?? []).length,
            codes: (result.Languages ?? []).map((l) => l.LanguageCode),
          });
        }

        // GetTerminology + ListTerminologies against the fixture glossary.
        if (request.method === "GET" && pathname === "/terminologies") {
          const got = yield* getTerminology({ Name: TERMINOLOGY_NAME });
          const listed = yield* listTerminologies({ MaxResults: 100 });
          return yield* HttpServerResponse.json({
            name: got.TerminologyProperties?.Name ?? null,
            termCount: got.TerminologyProperties?.TermCount ?? null,
            sourceLanguageCode:
              got.TerminologyProperties?.SourceLanguageCode ?? null,
            downloadLocation:
              got.TerminologyDataLocation?.RepositoryType ?? null,
            listedNames: (listed.TerminologyPropertiesList ?? []).flatMap(
              (t) => (t.Name ? [t.Name] : []),
            ),
          });
        }

        // ListParallelData + GetParallelData's typed not-found path.
        if (request.method === "GET" && pathname === "/parallel-data") {
          const listed = yield* listParallelData({ MaxResults: 100 });
          const missingTag = yield* getParallelData({
            Name: "alchemy-nonexistent-parallel-data",
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({
            listedCount: (listed.ParallelDataPropertiesList ?? []).length,
            missingTag,
          });
        }

        // ListTextTranslationJobs + the Describe/Stop typed not-found paths.
        if (request.method === "GET" && pathname === "/jobs") {
          const listed = yield* listTextTranslationJobs({ MaxResults: 5 });
          const describeTag = yield* describeTextTranslationJob({
            JobId: BOGUS_JOB_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const stopTag = yield* stopTextTranslationJob({
            JobId: BOGUS_JOB_ID,
          }).pipe(
            Effect.map(() => "Stopped"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({
            listedCount: (listed.TextTranslationJobPropertiesList ?? []).length,
            describeTag,
            stopTag,
          });
        }

        // Full real lifecycle for a batch translation job: seed the input
        // object, start the job, describe it, then stop it (the job never
        // needs to complete — that takes tens of minutes).
        if (request.method === "POST" && pathname === "/job-lifecycle") {
          yield* putObject({
            Key: "translate-input/greeting.txt",
            Body: "Hello, world!\nAlchemy deploys infrastructure.\n",
            ContentType: "text/plain",
          });
          // A freshly created data-access role can take a few seconds to
          // become assumable by Translate — surfaced as
          // InvalidParameterValueException/InvalidRequestException.
          // Bounded retry (8 × 5s).
          const started = yield* startTextTranslationJob({
            JobName: "alchemy-translate-bindings-lifecycle",
            InputDataConfig: {
              S3Uri: `s3://${FIXTURE_BUCKET_NAME}/translate-input/`,
              ContentType: "text/plain",
            },
            OutputDataConfig: {
              S3Uri: `s3://${FIXTURE_BUCKET_NAME}/translate-output/`,
            },
            SourceLanguageCode: "en",
            TargetLanguageCodes: ["es"],
          }).pipe(
            Effect.retry({
              while: (e): boolean =>
                e._tag === "InvalidParameterValueException" ||
                e._tag === "InvalidRequestException",
              schedule: Schedule.spaced("5 seconds"),
              times: 8,
            }),
          );
          const jobId = started.JobId ?? "";
          const described = yield* describeTextTranslationJob({
            JobId: jobId,
          });
          const stopped = yield* stopTextTranslationJob({ JobId: jobId });
          return yield* HttpServerResponse.json({
            jobId,
            startStatus: started.JobStatus ?? null,
            describedStatus:
              described.TextTranslationJobProperties?.JobStatus ?? null,
            stopStatus: stopped.JobStatus ?? null,
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
        Translate.TranslateTextHttp,
        Translate.TranslateDocumentHttp,
        Translate.ListLanguagesHttp,
        Translate.GetTerminologyHttp,
        Translate.ListTerminologiesHttp,
        Translate.GetParallelDataHttp,
        Translate.ListParallelDataHttp,
        Translate.StartTextTranslationJobHttp,
        Translate.DescribeTextTranslationJobHttp,
        Translate.StopTextTranslationJobHttp,
        Translate.ListTextTranslationJobsHttp,
        S3.PutObjectHttp,
        TranslateFixturesLive,
      ),
    ),
  ),
);
