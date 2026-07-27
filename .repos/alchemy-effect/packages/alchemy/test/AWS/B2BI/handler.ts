import * as AWS from "@/AWS";
import type { PolicyStatement } from "@/AWS/IAM";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Deterministic bucket for EDI input/output. B2BI accesses the bucket as the
// service principal, authorized by the bucket policy below.
export const BUCKET = "alchemy-test-b2bi-bindings";
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;

// Deterministic queue name so the test can look up the queue URL out-of-band
// (sqs.getQueueUrl) and observe delivered transformation events.
export const EVENTS_QUEUE = "alchemy-b2bi-bindings-events";

// A minimal, valid X12 850 (purchase order), version 4010 — checked in as a
// constant fixture, never generated at test time.
export const SAMPLE_850_EDI = [
  "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *210101*1253*U*00401*000000001*0*T*>~",
  "GS*PO*SENDERID*RECEIVERID*20210101*1253*1*X*004010~",
  "ST*850*0001~",
  "BEG*00*SA*XX-1234**20210101~",
  "REF*DP*038~",
  "PO1*1*10*EA*9.25*TE*CB*065322-117~",
  "CTT*1~",
  "SE*6*0001~",
  "GE*1*1~",
  "IEA*1*000000001~",
  "",
].join("\n");

const b2biBucketPolicy: PolicyStatement[] = [
  {
    Effect: "Allow",
    Principal: { Service: "b2bi.amazonaws.com" },
    Action: [
      "s3:GetObject",
      "s3:GetObjectAttributes",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:AbortMultipartUpload",
    ],
    Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
  },
];

export class B2biTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "B2biTestFunction",
) {}

/**
 * Shared infrastructure for the B2BI bindings fixture: the EDI S3 bucket,
 * an ACTIVE inbound X12 850 transformer, and an SQS sink queue where the
 * transformation-event consume loop forwards events so the test can observe
 * them out-of-band.
 */
export class B2biFixtures extends Context.Service<
  B2biFixtures,
  {
    bucket: AWS.S3.Bucket;
    transformer: AWS.B2BI.Transformer;
    eventsQueue: AWS.SQS.Queue;
  }
>()("B2biFixtures") {}

export const B2biFixturesLive = Layer.effect(
  B2biFixtures,
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("B2biData", {
      bucketName: BUCKET,
      forceDestroy: true,
      policy: b2biBucketPolicy,
    });
    const transformer = yield* AWS.B2BI.Transformer("BindingsTransformer", {
      name: "alchemy-b2bi-bindings-transformer",
      status: "active",
      inputConversion: {
        fromFormat: "X12",
        formatOptions: {
          x12: { transactionSet: "X12_850", version: "VERSION_4010" },
        },
      },
      mapping: {
        templateLanguage: "JSONATA",
        template: '{ "orderId": "test" }',
      },
    });
    const eventsQueue = yield* AWS.SQS.Queue("B2biEventsSink", {
      queueName: EVENTS_QUEUE,
    });
    return { bucket, transformer, eventsQueue };
  }),
);

export default B2biTestFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.minutes(2),
  },
  Effect.gen(function* () {
    const { bucket, transformer, eventsQueue } = yield* B2biFixtures;

    // --- data-plane bindings under test ---
    const putObject = yield* AWS.S3.PutObject(bucket);
    const startTransformerJob =
      yield* AWS.B2BI.StartTransformerJob(transformer);
    const getTransformerJob = yield* AWS.B2BI.GetTransformerJob(transformer);
    const testMapping = yield* AWS.B2BI.TestMapping();
    const testParsing = yield* AWS.B2BI.TestParsing();
    const testConversion = yield* AWS.B2BI.TestConversion();
    const generateMapping = yield* AWS.B2BI.GenerateMapping();
    const createStarterMappingTemplate =
      yield* AWS.B2BI.CreateStarterMappingTemplate();
    const eventsSink = yield* AWS.SQS.QueueSink(eventsQueue);

    // Event source under test: forward every B2BI transformation event to
    // the sink queue where the test observes it out-of-band.
    yield* AWS.B2BI.consumeTransformationEvents({}, (events) =>
      events.pipe(
        Stream.map((event) => ({
          MessageBody: JSON.stringify({
            detailType: event["detail-type"],
            transformerJobId: event.detail["transformer-job-id"] ?? null,
            output: event.detail["output-file-s3-attributes"] ?? null,
          }),
        })),
        Stream.run(eventsSink),
        Effect.orDie,
      ),
    );

    const bound = {
      startTransformerJob,
      getTransformerJob,
      testMapping,
      testParsing,
      testConversion,
      generateMapping,
      createStarterMappingTemplate,
      putObject,
    };

    const uploadSampleEdi = (key: string) =>
      putObject({
        Key: key,
        Body: SAMPLE_850_EDI,
        ContentType: "text/plain",
      });

    const parseSampleEdi = (key: string) =>
      uploadSampleEdi(key).pipe(
        Effect.flatMap(() =>
          testParsing({
            inputFile: { bucketName: BUCKET, key },
            fileFormat: "JSON",
            ediType: {
              x12Details: {
                transactionSet: "X12_850",
                version: "VERSION_4010",
              },
            },
          }),
        ),
      );

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

        if (request.method === "POST" && pathname === "/test-mapping") {
          const result = yield* testMapping({
            inputFileContent: JSON.stringify({ customer: "acme" }),
            mappingTemplate: '{ "name": customer }',
            fileFormat: "JSON",
          });
          return yield* HttpServerResponse.json({
            mappedFileContent: result.mappedFileContent,
          });
        }

        if (request.method === "POST" && pathname === "/starter-template") {
          const result = yield* createStarterMappingTemplate({
            mappingType: "JSONATA",
            templateDetails: {
              x12: { transactionSet: "X12_850", version: "VERSION_4010" },
            },
          });
          return yield* HttpServerResponse.json({
            templateLength: result.mappingTemplate.length,
          });
        }

        if (request.method === "POST" && pathname === "/generate-mapping") {
          // GenerateMapping invokes Bedrock with the caller's session and
          // requires Bedrock MODEL ACCESS to be enabled (an account/region
          // entitlement). In the testing account the call succeeds on some
          // runs and is denied on others (cross-region model routing), so
          // the typed Bedrock-model-access rejection is reported explicitly
          // rather than treated as a binding failure.
          const result = yield* generateMapping({
            inputFileContent: JSON.stringify({
              customer: "acme",
              city: "portland",
            }),
            outputFileContent: JSON.stringify({ name: "acme" }),
            mappingType: "JSONATA",
          }).pipe(
            Effect.map((r) => ({
              templateLength: r.mappingTemplate.length,
              accuracy: r.mappingAccuracy ?? null,
              bedrockAccessDenied: false,
            })),
            Effect.catchTag("AccessDeniedException", (e) =>
              String(e.message).includes("Bedrock")
                ? Effect.succeed({
                    templateLength: 0,
                    accuracy: null,
                    bedrockAccessDenied: true,
                  })
                : Effect.fail(e),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/test-parsing") {
          const result = yield* parseSampleEdi("test-parsing/sample-850.edi");
          return yield* HttpServerResponse.json({
            parsed: JSON.parse(result.parsedFileContent),
            validationMessages: result.validationMessages ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/test-conversion") {
          // Round-trip: parse the sample 850 into B2BI's JSON representation,
          // then convert that JSON back into an X12 document.
          const parsed = yield* parseSampleEdi(
            "test-conversion/sample-850.edi",
          );
          const result = yield* testConversion({
            source: {
              fileFormat: "JSON",
              inputFile: { fileContent: parsed.parsedFileContent },
            },
            target: {
              fileFormat: "X12",
              formatDetails: {
                x12: { transactionSet: "X12_850", version: "VERSION_4010" },
              },
            },
          });
          return yield* HttpServerResponse.json({
            convertedLength: result.convertedFileContent.length,
            startsWithIsa: result.convertedFileContent.startsWith("ISA"),
            validationMessages: result.validationMessages ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/transformer-job") {
          yield* uploadSampleEdi("job-input/sample-850.edi");
          const started = yield* startTransformerJob({
            inputFile: { bucketName: BUCKET, key: "job-input/sample-850.edi" },
            outputLocation: { bucketName: BUCKET, key: "job-output/" },
          });
          // A freshly started job can briefly 404; retry the typed tag, then
          // poll (bounded) until the job leaves `running`.
          const job = yield* getTransformerJob({
            transformerJobId: started.transformerJobId,
          }).pipe(
            Effect.retry({
              while: (e) => e._tag === "ResourceNotFoundException",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(5),
              ]),
            }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (j): boolean => j.status !== "running",
              times: 25,
            }),
          );
          return yield* HttpServerResponse.json({
            transformerJobId: started.transformerJobId,
            status: job.status,
            message: job.message ?? null,
            outputFiles: job.outputFiles ?? [],
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
      Layer.provideMerge(
        Layer.mergeAll(
          AWS.Lambda.EventSource,
          AWS.S3.PutObjectHttp,
          AWS.SQS.QueueSinkHttp,
          AWS.B2BI.StartTransformerJobHttp,
          AWS.B2BI.GetTransformerJobHttp,
          AWS.B2BI.TestMappingHttp,
          AWS.B2BI.TestParsingHttp,
          AWS.B2BI.TestConversionHttp,
          AWS.B2BI.GenerateMappingHttp,
          AWS.B2BI.CreateStarterMappingTemplateHttp,
          B2biFixturesLive,
        ),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp),
      ),
    ),
  ),
);
