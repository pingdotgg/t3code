import * as Comprehend from "@/AWS/Comprehend";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic fixture names (bucket names are account-global; this suite
// owns them in the testing account).
export const FIXTURE_BUCKET_NAME = "alchemy-test-comprehend-bindings";

// Well-formed-but-nonexistent job id used to drive the typed
// JobNotFoundException paths. An IAM gap would surface AccessDeniedException
// (a 500 through the handler's orDie), so a typed not-found tag proves the
// grant end-to-end.
const BOGUS_JOB_ID = "00000000000000000000000000000000";

// An S3 URI that fails Comprehend's server-side pattern validation — drives
// the Start*Job bindings through their typed ValidationException path
// without actually starting (and paying for) an async job per family.
const INVALID_S3_URI = "invalid-uri";

export class ComprehendTestFunction extends Lambda.Function<Lambda.Function>()(
  "ComprehendTestFunction",
) {}

export default ComprehendTestFunction.make(
  {
    main,
    url: true,
    // The sentiment job lifecycle route retries StartSentimentDetectionJob
    // through fresh-role IAM propagation (bounded ~40s).
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("ComprehendInputBucket", {
      bucketName: FIXTURE_BUCKET_NAME,
      forceDestroy: true,
    });
    // The role Amazon Comprehend assumes to read input documents and write
    // job results for the Start*Job bindings.
    const dataAccessRole = yield* IAM.Role("ComprehendDataAccessRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "comprehend.amazonaws.com" },
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
    // Used by /classify-document to build a well-formed same-account
    // endpoint ARN (a cross-account ARN returns NotAuthorizedException
    // instead of the typed ResourceUnavailableException).
    const roleArn = yield* dataAccessRole.roleArn;

    const putObject = yield* S3.PutObject(bucket);

    // --- real-time analysis bindings ---
    const detectDominantLanguage = yield* Comprehend.DetectDominantLanguage();
    const detectEntities = yield* Comprehend.DetectEntities();
    const detectKeyPhrases = yield* Comprehend.DetectKeyPhrases();
    const detectPiiEntities = yield* Comprehend.DetectPiiEntities();
    const detectSentiment = yield* Comprehend.DetectSentiment();
    const detectSyntax = yield* Comprehend.DetectSyntax();
    const detectTargetedSentiment = yield* Comprehend.DetectTargetedSentiment();
    const detectToxicContent = yield* Comprehend.DetectToxicContent();
    const containsPiiEntities = yield* Comprehend.ContainsPiiEntities();
    const classifyDocument = yield* Comprehend.ClassifyDocument();

    // --- batch real-time analysis bindings ---
    const batchDetectDominantLanguage =
      yield* Comprehend.BatchDetectDominantLanguage();
    const batchDetectEntities = yield* Comprehend.BatchDetectEntities();
    const batchDetectKeyPhrases = yield* Comprehend.BatchDetectKeyPhrases();
    const batchDetectSentiment = yield* Comprehend.BatchDetectSentiment();
    const batchDetectSyntax = yield* Comprehend.BatchDetectSyntax();
    const batchDetectTargetedSentiment =
      yield* Comprehend.BatchDetectTargetedSentiment();

    // --- async job bindings (role injection + PassRole grant) ---
    const startDocumentClassificationJob =
      yield* Comprehend.StartDocumentClassificationJob(dataAccessRole);
    const startDominantLanguageDetectionJob =
      yield* Comprehend.StartDominantLanguageDetectionJob(dataAccessRole);
    const startEntitiesDetectionJob =
      yield* Comprehend.StartEntitiesDetectionJob(dataAccessRole);
    const startEventsDetectionJob =
      yield* Comprehend.StartEventsDetectionJob(dataAccessRole);
    const startKeyPhrasesDetectionJob =
      yield* Comprehend.StartKeyPhrasesDetectionJob(dataAccessRole);
    const startPiiEntitiesDetectionJob =
      yield* Comprehend.StartPiiEntitiesDetectionJob(dataAccessRole);
    const startSentimentDetectionJob =
      yield* Comprehend.StartSentimentDetectionJob(dataAccessRole);
    const startTargetedSentimentDetectionJob =
      yield* Comprehend.StartTargetedSentimentDetectionJob(dataAccessRole);
    const startTopicsDetectionJob =
      yield* Comprehend.StartTopicsDetectionJob(dataAccessRole);

    const describeDocumentClassificationJob =
      yield* Comprehend.DescribeDocumentClassificationJob();
    const describeDominantLanguageDetectionJob =
      yield* Comprehend.DescribeDominantLanguageDetectionJob();
    const describeEntitiesDetectionJob =
      yield* Comprehend.DescribeEntitiesDetectionJob();
    const describeEventsDetectionJob =
      yield* Comprehend.DescribeEventsDetectionJob();
    const describeKeyPhrasesDetectionJob =
      yield* Comprehend.DescribeKeyPhrasesDetectionJob();
    const describePiiEntitiesDetectionJob =
      yield* Comprehend.DescribePiiEntitiesDetectionJob();
    const describeSentimentDetectionJob =
      yield* Comprehend.DescribeSentimentDetectionJob();
    const describeTargetedSentimentDetectionJob =
      yield* Comprehend.DescribeTargetedSentimentDetectionJob();
    const describeTopicsDetectionJob =
      yield* Comprehend.DescribeTopicsDetectionJob();

    const listDocumentClassificationJobs =
      yield* Comprehend.ListDocumentClassificationJobs();
    const listDominantLanguageDetectionJobs =
      yield* Comprehend.ListDominantLanguageDetectionJobs();
    const listEntitiesDetectionJobs =
      yield* Comprehend.ListEntitiesDetectionJobs();
    const listEventsDetectionJobs = yield* Comprehend.ListEventsDetectionJobs();
    const listKeyPhrasesDetectionJobs =
      yield* Comprehend.ListKeyPhrasesDetectionJobs();
    const listPiiEntitiesDetectionJobs =
      yield* Comprehend.ListPiiEntitiesDetectionJobs();
    const listSentimentDetectionJobs =
      yield* Comprehend.ListSentimentDetectionJobs();
    const listTargetedSentimentDetectionJobs =
      yield* Comprehend.ListTargetedSentimentDetectionJobs();
    const listTopicsDetectionJobs = yield* Comprehend.ListTopicsDetectionJobs();

    const stopDominantLanguageDetectionJob =
      yield* Comprehend.StopDominantLanguageDetectionJob();
    const stopEntitiesDetectionJob =
      yield* Comprehend.StopEntitiesDetectionJob();
    const stopEventsDetectionJob = yield* Comprehend.StopEventsDetectionJob();
    const stopKeyPhrasesDetectionJob =
      yield* Comprehend.StopKeyPhrasesDetectionJob();
    const stopPiiEntitiesDetectionJob =
      yield* Comprehend.StopPiiEntitiesDetectionJob();
    const stopSentimentDetectionJob =
      yield* Comprehend.StopSentimentDetectionJob();
    const stopTargetedSentimentDetectionJob =
      yield* Comprehend.StopTargetedSentimentDetectionJob();

    const PII_TEXT =
      "My name is Jane Doe and my email address is jane@example.com.";
    const REVIEW_TEXT = "I love this product, it works wonderfully!";
    const BATCH_TEXTS = [
      "I love this product, it works wonderfully!",
      "The delivery was late and the box arrived damaged.",
    ];

    const jobInput = {
      InputDataConfig: {
        S3Uri: `s3://${FIXTURE_BUCKET_NAME}/comprehend-input/`,
        InputFormat: "ONE_DOC_PER_LINE" as const,
      },
      OutputDataConfig: {
        S3Uri: `s3://${FIXTURE_BUCKET_NAME}/comprehend-output/`,
      },
    };
    const invalidJobInput = {
      InputDataConfig: { S3Uri: INVALID_S3_URI },
      OutputDataConfig: { S3Uri: INVALID_S3_URI },
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Comprehend call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        // One route drives every single-document real-time binding.
        if (request.method === "GET" && pathname === "/detect-all") {
          const language = yield* detectDominantLanguage({
            Text: "Bob ordered two sandwiches yesterday.",
          });
          const entities = yield* detectEntities({
            Text: "Bob moved to Seattle in 2017.",
            LanguageCode: "en",
          });
          const keyPhrases = yield* detectKeyPhrases({
            Text: "The quarterly earnings report exceeded analyst expectations.",
            LanguageCode: "en",
          });
          const pii = yield* detectPiiEntities({
            Text: PII_TEXT,
            LanguageCode: "en",
          });
          const sentiment = yield* detectSentiment({
            Text: REVIEW_TEXT,
            LanguageCode: "en",
          });
          const syntax = yield* detectSyntax({
            Text: "The cat sat on the mat.",
            LanguageCode: "en",
          });
          const targeted = yield* detectTargetedSentiment({
            Text: "The screen is gorgeous but the battery is disappointing.",
            LanguageCode: "en",
          });
          const toxic = yield* detectToxicContent({
            TextSegments: [{ Text: "You are a wonderful person." }],
            LanguageCode: "en",
          });
          const piiLabels = yield* containsPiiEntities({
            Text: PII_TEXT,
            LanguageCode: "en",
          });
          return yield* HttpServerResponse.json({
            languageCode: language.Languages?.[0]?.LanguageCode,
            entityTypes: (entities.Entities ?? []).map((e) => e.Type),
            keyPhraseCount: (keyPhrases.KeyPhrases ?? []).length,
            piiTypes: (pii.Entities ?? []).map((e) => e.Type),
            sentiment: sentiment.Sentiment,
            syntaxTags: (syntax.SyntaxTokens ?? []).map(
              (t) => t.PartOfSpeech?.Tag,
            ),
            targetedEntityCount: (targeted.Entities ?? []).length,
            toxicity: toxic.ResultList?.[0]?.Toxicity,
            piiLabels: (piiLabels.Labels ?? []).map((l) => l.Name),
          });
        }

        // One route drives every batch real-time binding.
        if (request.method === "GET" && pathname === "/batch-all") {
          const language = yield* batchDetectDominantLanguage({
            TextList: BATCH_TEXTS,
          });
          const entities = yield* batchDetectEntities({
            TextList: ["Bob moved to Seattle in 2017."],
            LanguageCode: "en",
          });
          const keyPhrases = yield* batchDetectKeyPhrases({
            TextList: BATCH_TEXTS,
            LanguageCode: "en",
          });
          const sentiment = yield* batchDetectSentiment({
            TextList: BATCH_TEXTS,
            LanguageCode: "en",
          });
          const syntax = yield* batchDetectSyntax({
            TextList: ["The cat sat on the mat."],
            LanguageCode: "en",
          });
          const targeted = yield* batchDetectTargetedSentiment({
            TextList: ["The screen is gorgeous but the battery is bad."],
            LanguageCode: "en",
          });
          return yield* HttpServerResponse.json({
            languageResults: (language.ResultList ?? []).length,
            firstLanguage:
              language.ResultList?.[0]?.Languages?.[0]?.LanguageCode,
            entityResults: (entities.ResultList ?? []).length,
            keyPhraseResults: (keyPhrases.ResultList ?? []).length,
            sentimentResults: (sentiment.ResultList ?? []).length,
            firstSentiment: sentiment.ResultList?.[0]?.Sentiment,
            syntaxResults: (syntax.ResultList ?? []).length,
            targetedResults: (targeted.ResultList ?? []).length,
          });
        }

        // ClassifyDocument requires a trained custom endpoint; a well-formed
        // same-account ARN that doesn't exist drives the typed
        // ResourceUnavailableException path end-to-end (proving IAM + call
        // plumbing without a multi-hour classifier training run).
        if (request.method === "GET" && pathname === "/classify-document") {
          const region = yield* Effect.sync(() => process.env.AWS_REGION);
          const account = (yield* roleArn).split(":")[4];
          const tag = yield* classifyDocument({
            Text: "Subject: your invoice for March is attached",
            EndpointArn: `arn:aws:comprehend:${region}:${account}:document-classifier-endpoint/alchemy-nonexistent`,
          }).pipe(
            Effect.map(() => "Classified"),
            Effect.catchTag(
              [
                "ResourceUnavailableException",
                "InvalidRequestException",
                "NotAuthorizedException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        // One route drives all nine List*Jobs bindings.
        if (request.method === "GET" && pathname === "/jobs/list-all") {
          const counts = {
            documentClassification: (
              (yield* listDocumentClassificationJobs({ MaxResults: 5 }))
                .DocumentClassificationJobPropertiesList ?? []
            ).length,
            dominantLanguage: (
              (yield* listDominantLanguageDetectionJobs({ MaxResults: 5 }))
                .DominantLanguageDetectionJobPropertiesList ?? []
            ).length,
            entities: (
              (yield* listEntitiesDetectionJobs({ MaxResults: 5 }))
                .EntitiesDetectionJobPropertiesList ?? []
            ).length,
            events: (
              (yield* listEventsDetectionJobs({ MaxResults: 5 }))
                .EventsDetectionJobPropertiesList ?? []
            ).length,
            keyPhrases: (
              (yield* listKeyPhrasesDetectionJobs({ MaxResults: 5 }))
                .KeyPhrasesDetectionJobPropertiesList ?? []
            ).length,
            piiEntities: (
              (yield* listPiiEntitiesDetectionJobs({ MaxResults: 5 }))
                .PiiEntitiesDetectionJobPropertiesList ?? []
            ).length,
            sentiment: (
              (yield* listSentimentDetectionJobs({ MaxResults: 5 }))
                .SentimentDetectionJobPropertiesList ?? []
            ).length,
            targetedSentiment: (
              (yield* listTargetedSentimentDetectionJobs({ MaxResults: 5 }))
                .TargetedSentimentDetectionJobPropertiesList ?? []
            ).length,
            topics: (
              (yield* listTopicsDetectionJobs({ MaxResults: 5 }))
                .TopicsDetectionJobPropertiesList ?? []
            ).length,
          };
          return yield* HttpServerResponse.json(counts);
        }

        // One route drives all nine Describe*Job bindings through their
        // typed JobNotFoundException path.
        if (
          request.method === "GET" &&
          pathname === "/jobs/describe-not-found-all"
        ) {
          const probe = { JobId: BOGUS_JOB_ID };
          const tags = {
            documentClassification: yield* describeDocumentClassificationJob(
              probe,
            ).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            dominantLanguage: yield* describeDominantLanguageDetectionJob(
              probe,
            ).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            entities: yield* describeEntitiesDetectionJob(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            events: yield* describeEventsDetectionJob(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                ["JobNotFoundException", "NotAuthorizedException"],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            keyPhrases: yield* describeKeyPhrasesDetectionJob(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            piiEntities: yield* describePiiEntitiesDetectionJob(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            sentiment: yield* describeSentimentDetectionJob(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            targetedSentiment: yield* describeTargetedSentimentDetectionJob(
              probe,
            ).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            topics: yield* describeTopicsDetectionJob(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
          };
          return yield* HttpServerResponse.json(tags);
        }

        // One route drives all seven Stop*Job bindings through their typed
        // JobNotFoundException path.
        if (
          request.method === "POST" &&
          pathname === "/jobs/stop-not-found-all"
        ) {
          const probe = { JobId: BOGUS_JOB_ID };
          const tags = {
            dominantLanguage: yield* stopDominantLanguageDetectionJob(
              probe,
            ).pipe(
              Effect.map(() => "Stopped"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            entities: yield* stopEntitiesDetectionJob(probe).pipe(
              Effect.map(() => "Stopped"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            // Events detection is closed to new customers — the account
            // surfaces the (patched) typed NotAuthorizedException instead of
            // JobNotFoundException.
            events: yield* stopEventsDetectionJob(probe).pipe(
              Effect.map(() => "Stopped"),
              Effect.catchTag(
                ["JobNotFoundException", "NotAuthorizedException"],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            keyPhrases: yield* stopKeyPhrasesDetectionJob(probe).pipe(
              Effect.map(() => "Stopped"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            piiEntities: yield* stopPiiEntitiesDetectionJob(probe).pipe(
              Effect.map(() => "Stopped"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            sentiment: yield* stopSentimentDetectionJob(probe).pipe(
              Effect.map(() => "Stopped"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
            targetedSentiment: yield* stopTargetedSentimentDetectionJob(
              probe,
            ).pipe(
              Effect.map(() => "Stopped"),
              Effect.catchTag("JobNotFoundException", (e) =>
                Effect.succeed(e._tag),
              ),
            ),
          };
          return yield* HttpServerResponse.json(tags);
        }

        // Drives the eight non-sentiment Start*Job bindings through
        // Comprehend's server-side ValidationException (invalid S3 URI) —
        // a real runtime call proving role injection + IAM without paying
        // for eight async jobs. Sentiment gets the real lifecycle below.
        if (
          request.method === "POST" &&
          pathname === "/jobs/start-invalid-all"
        ) {
          const region = yield* Effect.sync(() => process.env.AWS_REGION);
          const account = (yield* roleArn).split(":")[4];
          const tags = {
            documentClassification: yield* startDocumentClassificationJob({
              ...invalidJobInput,
              DocumentClassifierArn: `arn:aws:comprehend:${region}:${account}:document-classifier/alchemy-nonexistent`,
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catchTag(
                [
                  "ValidationException",
                  "InvalidRequestException",
                  "ResourceNotFoundException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            dominantLanguage: yield* startDominantLanguageDetectionJob(
              invalidJobInput,
            ).pipe(
              Effect.map(() => "Started"),
              Effect.catchTag(
                ["ValidationException", "InvalidRequestException"],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            entities: yield* startEntitiesDetectionJob({
              ...invalidJobInput,
              LanguageCode: "en",
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catchTag(
                ["ValidationException", "InvalidRequestException"],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            events: yield* startEventsDetectionJob({
              ...invalidJobInput,
              LanguageCode: "en",
              TargetEventTypes: ["BANKRUPTCY"],
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catchTag(
                [
                  "ValidationException",
                  "InvalidRequestException",
                  "NotAuthorizedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            keyPhrases: yield* startKeyPhrasesDetectionJob({
              ...invalidJobInput,
              LanguageCode: "en",
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catchTag(
                ["ValidationException", "InvalidRequestException"],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            piiEntities: yield* startPiiEntitiesDetectionJob({
              ...invalidJobInput,
              Mode: "ONLY_OFFSETS",
              LanguageCode: "en",
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catchTag(
                ["ValidationException", "InvalidRequestException"],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            targetedSentiment: yield* startTargetedSentimentDetectionJob({
              ...invalidJobInput,
              LanguageCode: "en",
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catchTag(
                ["ValidationException", "InvalidRequestException"],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            topics: yield* startTopicsDetectionJob(invalidJobInput).pipe(
              Effect.map(() => "Started"),
              Effect.catchTag(
                ["ValidationException", "InvalidRequestException"],
                (e) => Effect.succeed(e._tag),
              ),
            ),
          };
          return yield* HttpServerResponse.json(tags);
        }

        // Full real lifecycle for the sentiment job family: seed the input
        // object, start a real async job, describe it, then stop it.
        if (
          request.method === "POST" &&
          pathname === "/jobs/sentiment/lifecycle"
        ) {
          yield* putObject({
            Key: "comprehend-input/reviews.txt",
            Body: "I love this product, it works wonderfully!\nThe delivery was late and the box arrived damaged.\n",
            ContentType: "text/plain",
          });
          // A freshly created data-access role can take a few seconds to
          // become assumable by Comprehend — surfaced as
          // InvalidRequestException. Bounded retry (8 × 5s).
          const started = yield* startSentimentDetectionJob({
            ...jobInput,
            JobName: "alchemy-comprehend-bindings-lifecycle",
            LanguageCode: "en",
          }).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "InvalidRequestException",
              schedule: Schedule.spaced("5 seconds"),
              times: 8,
            }),
          );
          const jobId = started.JobId ?? "";
          const described = yield* describeSentimentDetectionJob({
            JobId: jobId,
          });
          const stopped = yield* stopSentimentDetectionJob({ JobId: jobId });
          return yield* HttpServerResponse.json({
            jobId,
            startStatus: started.JobStatus,
            describedStatus:
              described.SentimentDetectionJobProperties?.JobStatus,
            stopStatus: stopped.JobStatus,
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
        S3.PutObjectHttp,
        Comprehend.DetectDominantLanguageHttp,
        Comprehend.DetectEntitiesHttp,
        Comprehend.DetectKeyPhrasesHttp,
        Comprehend.DetectPiiEntitiesHttp,
        Comprehend.DetectSentimentHttp,
        Comprehend.DetectSyntaxHttp,
        Comprehend.DetectTargetedSentimentHttp,
        Comprehend.DetectToxicContentHttp,
        Comprehend.ContainsPiiEntitiesHttp,
        Comprehend.ClassifyDocumentHttp,
        Comprehend.BatchDetectDominantLanguageHttp,
        Comprehend.BatchDetectEntitiesHttp,
        Comprehend.BatchDetectKeyPhrasesHttp,
        Comprehend.BatchDetectSentimentHttp,
        Comprehend.BatchDetectSyntaxHttp,
        Comprehend.BatchDetectTargetedSentimentHttp,
        Comprehend.StartDocumentClassificationJobHttp,
        Comprehend.StartDominantLanguageDetectionJobHttp,
        Comprehend.StartEntitiesDetectionJobHttp,
        Comprehend.StartEventsDetectionJobHttp,
        Comprehend.StartKeyPhrasesDetectionJobHttp,
        Comprehend.StartPiiEntitiesDetectionJobHttp,
        Comprehend.StartSentimentDetectionJobHttp,
        Comprehend.StartTargetedSentimentDetectionJobHttp,
        Comprehend.StartTopicsDetectionJobHttp,
        Comprehend.DescribeDocumentClassificationJobHttp,
        Comprehend.DescribeDominantLanguageDetectionJobHttp,
        Comprehend.DescribeEntitiesDetectionJobHttp,
        Comprehend.DescribeEventsDetectionJobHttp,
        Comprehend.DescribeKeyPhrasesDetectionJobHttp,
        Comprehend.DescribePiiEntitiesDetectionJobHttp,
        Comprehend.DescribeSentimentDetectionJobHttp,
        Comprehend.DescribeTargetedSentimentDetectionJobHttp,
        Comprehend.DescribeTopicsDetectionJobHttp,
        Comprehend.ListDocumentClassificationJobsHttp,
        Comprehend.ListDominantLanguageDetectionJobsHttp,
        Comprehend.ListEntitiesDetectionJobsHttp,
        Comprehend.ListEventsDetectionJobsHttp,
        Comprehend.ListKeyPhrasesDetectionJobsHttp,
        Comprehend.ListPiiEntitiesDetectionJobsHttp,
        Comprehend.ListSentimentDetectionJobsHttp,
        Comprehend.ListTargetedSentimentDetectionJobsHttp,
        Comprehend.ListTopicsDetectionJobsHttp,
        Comprehend.StopDominantLanguageDetectionJobHttp,
        Comprehend.StopEntitiesDetectionJobHttp,
        Comprehend.StopEventsDetectionJobHttp,
        Comprehend.StopKeyPhrasesDetectionJobHttp,
        Comprehend.StopPiiEntitiesDetectionJobHttp,
        Comprehend.StopSentimentDetectionJobHttp,
        Comprehend.StopTargetedSentimentDetectionJobHttp,
      ),
    ),
  ),
);
