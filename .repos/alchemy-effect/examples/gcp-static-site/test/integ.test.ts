import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// Kept for the post-destroy check in `afterAll`.
let deployedBucket: string | undefined;

const stack = beforeAll(
  Effect.gen(function* () {
    const outputs = yield* deploy(Stack);
    deployedBucket = outputs.bucketName;
    return outputs;
  }),
  { timeout: 300_000 },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    yield* destroy(Stack);
    if (deployedBucket === undefined) return;
    // Destroy empties and deletes the bucket (its public grant goes with it).
    const bucket = yield* storage.getBuckets({ bucket: deployedBucket }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    );
    expect(bucket).toEqual("gone");
  }).pipe(Effect.provide(GcpHttp)),
  { timeout: 300_000 },
);

// Anonymous GET — no credentials, exactly what a browser sends.
const get = (url: string) => HttpClient.execute(HttpClientRequest.get(url));

// The `allUsers` grant can take a little while to apply to fresh buckets;
// until then anonymous reads answer 401/403.
const getPublic = (url: string) =>
  get(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (response) => response.status !== 401 && response.status !== 403,
      times: 24,
    }),
  );

const siteBase = (bucketName: string) =>
  `https://storage.googleapis.com/${bucketName}`;

test(
  "serves index.html publicly with its content type",
  Effect.gen(function* () {
    const { url, fileCount } = yield* stack;
    expect(fileCount).toEqual(4);

    const res = yield* getPublic(url);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toEqual("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toEqual("no-cache");
    expect(yield* res.text).toContain("GCP static site on Cloud Storage");
  }),
  { timeout: 180_000 },
);

test(
  "serves nested pages and assets with correct content types",
  Effect.gen(function* () {
    const { bucketName } = yield* stack;
    const base = siteBase(bucketName);

    const css = yield* getPublic(`${base}/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toEqual("text/css; charset=utf-8");
    expect(css.headers["cache-control"]).toEqual("public, max-age=300");
    expect(yield* css.text).toContain(".page");

    const docs = yield* getPublic(`${base}/docs/index.html`);
    expect(docs.status).toBe(200);
    expect(docs.headers["content-type"]).toEqual("text/html; charset=utf-8");
    expect(yield* docs.text).toContain("How it works");

    const notFoundPage = yield* getPublic(`${base}/404.html`);
    expect(notFoundPage.status).toBe(200);
    expect(yield* notFoundPage.text).toContain("Page not found");
  }),
  { timeout: 180_000 },
);

test(
  "a missing path is a 404 and the website config is set",
  Effect.gen(function* () {
    const { bucketName } = yield* stack;
    // Path-style URLs answer a missing object with Cloud Storage's own
    // 404; the `notFoundPage` body is served only through a CNAME or a
    // load balancer, so it is asserted on the bucket config instead.
    const missing = yield* getPublic(`${siteBase(bucketName)}/nope.html`);
    expect(missing.status).toBe(404);

    const bucket = yield* storage
      .getBuckets({ bucket: bucketName })
      .pipe(Effect.provide(GcpHttp));
    expect(bucket.website).toEqual({
      mainPageSuffix: "index.html",
      notFoundPage: "404.html",
    });

    const policy = yield* storage
      .getIamPolicyBuckets({ bucket: bucketName })
      .pipe(Effect.provide(GcpHttp));
    const viewers = policy.bindings?.find(
      (binding) => binding.role === "roles/storage.objectViewer",
    );
    expect(viewers?.members).toContain("allUsers");
  }),
  { timeout: 180_000 },
);
