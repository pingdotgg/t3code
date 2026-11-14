import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { drainSubscription } from "../K2/k2-test-utils.ts";
import ExternalHostLambdaLive, {
  Bucket,
  ExternalHostLambda,
  K2Stream,
  Namespace,
} from "./fixtures/handler.ts";

const providers = Layer.mergeAll(AWS.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "CloudflareExternalHostStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* ExternalHostLambda;
    const bucket = yield* Bucket;
    const namespace = yield* Namespace;
    const stream = yield* K2Stream;
    const verifier = yield* Cloudflare.K2.Subscription("ExternalHostVerifier", {
      stream,
      startAt: "earliest",
    });
    return {
      streamId: stream.streamId,
      subscriptionId: verifier.subscriptionId,
      url: fn.functionUrl.as<string>(),
      bucketName: bucket.bucketName,
      namespaceId: namespace.namespaceId,
    };
  }).pipe(Effect.provide(ExternalHostLambdaLive)),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

// A fresh function URL and the minted token take a while to start serving:
// retry non-2xx answers, failing with the last Cloudflare error.
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url!.replace(/\/$/, "")}${route}`).pipe(
      Effect.timeout("25 seconds"),
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.flatMap((body) =>
            response.status === 200
              ? Effect.succeed(JSON.parse(body) as any)
              : Effect.fail(new NotReady({ status: response.status, body })),
          ),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 40 }),
    );
  });

describe(
  "Cloudflare *Http bindings on an AWS Lambda",
  { tags: ["provider:aws", "provider:cloudflare", "live"] },
  () => {
    // `test.provider` supplies the Cloudflare credentials for the out-of-band reads.
    test.provider(
      "R2 ReadWriteBucket",
      (_stack) =>
        Effect.gen(function* () {
          expect(yield* call("/r2?key=r2-roundtrip")).toEqual({ value: "from-lambda" });

          const { bucketName } = yield* stack;
          const { accountId } = yield* yield* CloudflareEnvironment;
          const object = yield* r2.getObject({
            accountId,
            bucketName: bucketName!,
            objectName: "r2-roundtrip",
          });
          expect(yield* object.body.pipe(Stream.decodeText, Stream.mkString)).toBe("from-lambda");
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "KV ReadWriteNamespace",
      (_stack) =>
        Effect.gen(function* () {
          expect(yield* call("/kv?key=kv-roundtrip")).toEqual({ value: "from-lambda" });

          const { namespaceId } = yield* stack;
          const { accountId } = yield* yield* CloudflareEnvironment;
          const value = yield* kv
            .getNamespaceValue({ accountId, namespaceId: namespaceId!, keyName: "kv-roundtrip" })
            .pipe(Effect.flatMap((res) => res.body.pipe(Stream.decodeText, Stream.mkString)));
          expect(value).toBe("from-lambda");
        }),
      { timeout: 240_000 },
    );

    test(
      "Queues WriteQueue",
      Effect.gen(function* () {
        expect(yield* call("/queue?key=queue-send")).toEqual({ sent: true });
      }),
      { timeout: 240_000 },
    );

    test.provider(
      "K2 WriteStream",
      (_stack) =>
        Effect.gen(function* () {
          expect(yield* call("/k2?key=k2-send")).toEqual({ sent: true });

          const { streamId, subscriptionId } = yield* stack;
          const records = yield* drainSubscription(streamId!, subscriptionId!, 1);
          expect(records.map((record) => JSON.parse(record.text))).toContainEqual({
            key: "k2-send",
          });
        }),
      { timeout: 240_000 },
    );
  },
);
