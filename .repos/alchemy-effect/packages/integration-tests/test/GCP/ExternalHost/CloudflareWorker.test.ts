import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ExternalHostWorker, { Bucket } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(GCP.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "GcpExternalHostStack",
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

// A fresh workers.dev URL, the minted key and the account's new role grants
// take a while to propagate: retry until the route answers `ok`, then report
// the last answer so a real failure shows its GCP error.
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("20 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe(
  "GCP bindings on a Cloudflare Worker",
  { tags: ["provider:gcp", "provider:cloudflare", "live"] },
  () => {
    // `test.provider` supplies the GCP credentials for the out-of-band read.
    test.provider(
      "Storage ReadWriteBucket",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* call("/storage?key=storage-roundtrip");
          expectOk(body);
          expect(body.result.text).toBe("from-worker");

          const { bucketName } = yield* stack;
          const object = yield* storage.getObjects({
            bucket: bucketName!,
            object: "storage-roundtrip",
          });
          expect(object.size).toBe(String("from-worker".length));
        }),
      { timeout: 240_000 },
    );

    test(
      "Pub/Sub WriteTopic",
      Effect.gen(function* () {
        const body = yield* call("/pubsub?key=pubsub-publish");
        expectOk(body);
        expect(body.result.messageId).toBeTruthy();
      }),
      { timeout: 240_000 },
    );
  },
);
