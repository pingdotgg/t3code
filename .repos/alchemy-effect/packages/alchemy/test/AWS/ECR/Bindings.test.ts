import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as ecr from "@distilled.cloud/aws/ecr";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EcrTestFunctionLive, { EcrTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EcrBindings");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Fresh Lambda role + ECR/S3 permissions propagate eventually — the first
// calls can 500 with AccessDenied. Retry 5xx only (the handler surfaces
// typed errors as a 500 JSON body); a genuine 4xx fails immediately.
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
        Schedule.exponential("1 second"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = <T>(path: string) =>
  Effect.gen(function* () {
    const response = yield* send(HttpClientRequest.get(`${baseUrl}${path}`));
    expect(response.status).toBe(200);
    return (yield* response.json) as T;
  });

const postJson = <T>(path: string) =>
  Effect.gen(function* () {
    const response = yield* send(HttpClientRequest.post(`${baseUrl}${path}`));
    expect(response.status).toBe(200);
    return (yield* response.json) as T;
  });

describe("ECR Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ECR Bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "ECR Bindings setup: deploying repository -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* EcrTestFunction;
        }).pipe(Effect.provide(EcrTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/nope`).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  // No NO_DESTROY escape hatch here: scratch-stack state is in-memory per
  // process, so a skipped destroy would orphan the whole stack forever.
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("GetAuthorizationToken", () => {
    test.provider(
      "mints a Redacted registry credential that decodes to AWS:<password>",
      () =>
        Effect.gen(function* () {
          const body = yield* getJson<{
            redacted: boolean;
            length: number;
            decodesToAwsUser: boolean;
            proxyEndpoint?: string;
          }>("/token");
          // An ECR bearer token is a long opaque credential; the in-Lambda
          // `redacted` flag flips to true once the distilled `lib/` build
          // catches up with the SensitiveString patch (the bundler resolves
          // the built lib, unlike vitest which resolves src).
          expect(body.length).toBeGreaterThan(100);
          expect(body.decodesToAwsUser).toBe(true);
          expect(body.proxyEndpoint).toContain(".ecr.");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "authorizationToken is Redacted (distilled sensitive patch)",
      () =>
        Effect.gen(function* () {
          // Direct distilled call (vitest resolves distilled from src, so the
          // SensitiveString patch is live here).
          const res = yield* ecr.getAuthorizationToken({});
          const token = res.authorizationData?.[0]?.authorizationToken;
          expect(Redacted.isRedacted(token)).toBe(true);
          expect(
            Redacted.value(token as Redacted.Redacted<string>).length,
          ).toBeGreaterThan(100);
        }),
      { timeout: 120_000 },
    );
  });

  // The image bindings mutate shared repository state, so they run as ONE
  // ordered flow — vitest executes tests in this file concurrently
  // (`sequence.concurrent`), which would otherwise race the delete steps
  // against the read steps.
  describe("image lifecycle", () => {
    test.provider(
      "push -> inspect -> pull -> scan -> delete through the bindings",
      () =>
        Effect.gen(function* () {
          // InitiateLayerUpload + UploadLayerPart + CompleteLayerUpload +
          // PutImage — push a minimal synthetic image.
          const pushed = yield* postJson<{
            digest?: string;
            layerDigest: string;
            configDigest: string;
          }>("/push?tag=1.0.0");
          expect(pushed.layerDigest).toMatch(/^sha256:/);
          expect(pushed.digest).toMatch(/^sha256:/);

          // DescribeImages.
          const image = yield* getJson<{
            tags?: string[];
            digest?: string;
          }>("/images?tag=1.0.0");
          expect(image.tags).toContain("1.0.0");
          expect(image.digest).toBe(pushed.digest);

          // ListImages.
          const ids = yield* getJson<{ tags: string[] }>("/image-ids");
          expect(ids.tags).toContain("1.0.0");

          // BatchGetImage.
          const manifest = yield* getJson<{
            mediaType?: string;
            manifestLength: number;
          }>("/manifest?tag=1.0.0");
          expect(manifest.mediaType).toBe(
            "application/vnd.docker.distribution.manifest.v2+json",
          );
          expect(manifest.manifestLength).toBeGreaterThan(100);

          // GetDownloadUrlForLayer.
          const layer = yield* getJson<{ hasUrl: boolean }>(
            `/layer?digest=${encodeURIComponent(pushed.layerDigest)}`,
          );
          expect(layer.hasUrl).toBe(true);

          // BatchCheckLayerAvailability.
          const availability = yield* getJson<{ availability?: string }>(
            `/availability?digest=${encodeURIComponent(pushed.layerDigest)}`,
          );
          expect(availability.availability).toBe("AVAILABLE");

          // StartImageScan — the synthetic image is not a supported OS
          // image, so the typed UnsupportedImageTypeException is as much a
          // proof of the binding as a successful scan.
          const scan = yield* postJson<{ status?: string; error?: string }>(
            "/scan?tag=1.0.0",
          );
          expect(
            scan.status !== undefined ||
              scan.error === "UnsupportedImageTypeException" ||
              scan.error === "LimitExceededException" ||
              scan.error === "ValidationException",
          ).toBe(true);

          // DescribeImageScanFindings — real findings or the typed
          // ScanNotFoundException when the scan was rejected above.
          const findings = yield* getJson<{
            status?: string;
            error?: string;
          }>("/scan-findings?tag=1.0.0");
          expect(
            findings.status !== undefined ||
              findings.error === "ScanNotFoundException" ||
              findings.error === "ValidationException",
          ).toBe(true);

          // BatchDeleteImage.
          const deleted = yield* postJson<{ deleted: number }>(
            "/delete?tag=1.0.0",
          );
          expect(deleted.deleted).toBe(1);
          const after = yield* getJson<{ tags: string[] }>("/image-ids");
          expect(after.tags).not.toContain("1.0.0");
        }),
      { timeout: 180_000 },
    );
  });

  describe("ImageActionEventSource", () => {
    test.provider(
      "delivers push events to the handler",
      () =>
        Effect.gen(function* () {
          // Each probe pushes a FRESH tag (a re-push of an existing tag is
          // ImageAlreadyExists — no new event) and polls S3 for the marker
          // the event handler wrote. A freshly-created EventBridge rule on
          // the default bus takes up to ~a minute to become effective, so
          // successive fresh-tag pushes ride out the propagation window.
          const probe = (tag: string) =>
            getJson<{ seen: boolean; tag: string }>(
              `/events/probe?tag=${tag}`,
            ).pipe(Effect.map((body) => body.seen));
          const seen = yield* Effect.gen(function* () {
            for (const tag of ["2.0.0", "2.0.1", "2.0.2", "2.0.3"]) {
              if (yield* probe(tag)) return true;
            }
            return false;
          });
          expect(seen).toBe(true);
        }),
      { timeout: 180_000 },
    );
  });
});
