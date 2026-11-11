import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ExternalHostWorker, { Bucket } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(AWS.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AwsExternalHostStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ExternalHostWorker;
    const bucket = yield* Bucket;
    return { url: worker.url.as<string>(), bucketName: bucket.bucketName };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

type Body = { ok: boolean; result?: any; error?: string };

// A fresh workers.dev URL, the minted access key and the role's trust policy
// take a while to propagate: retry until the route answers `ok`, then report
// the last answer so a real failure shows its AWS error.
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("20 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 30 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe(
  "AWS bindings on a Cloudflare Worker",
  { tags: ["provider:aws", "provider:cloudflare", "live"] },
  () => {
    // `test.provider` supplies the AWS credentials for the out-of-band read.
    test.provider(
      "S3 PutObject + GetObject",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* call("/s3?key=s3-roundtrip");
          expectOk(body);
          expect(body.result.contentLength).toBe("from-worker".length);

          const { bucketName } = yield* stack;
          const object = yield* s3.getObject({ Bucket: bucketName!, Key: "s3-roundtrip" });
          expect(object.ContentLength).toBe("from-worker".length);
        }),
      { timeout: 180_000 },
    );

    test(
      "S3 PresignGetObject",
      Effect.gen(function* () {
        const body = yield* call("/s3/presign?key=s3-presign");
        expectOk(body);
        const text = yield* HttpClient.get(body.result.url).pipe(
          Effect.flatMap((response) => response.text),
        );
        expect(text).toBe("presigned");
      }),
      { timeout: 180_000 },
    );

    test(
      "DynamoDB PutItem + GetItem",
      Effect.gen(function* () {
        const body = yield* call("/dynamodb?key=ddb-roundtrip");
        expectOk(body);
        expect(body.result.found).toBe(true);
      }),
      { timeout: 180_000 },
    );

    test(
      "SQS SendMessage + ReceiveMessage",
      Effect.gen(function* () {
        const body = yield* call("/sqs?key=sqs-roundtrip");
        expectOk(body);
        expect(body.result.bodies).toContain("sqs-roundtrip");
      }),
      { timeout: 180_000 },
    );

    test(
      "AccessAnalyzer ValidatePolicy (account-level)",
      Effect.gen(function* () {
        const body = yield* call("/access-analyzer");
        expectOk(body);
        expect(Array.isArray(body.result.findings)).toBe(true);
      }),
      { timeout: 180_000 },
    );
  },
);
