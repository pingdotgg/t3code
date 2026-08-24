import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ElbBindingsFunctionLive, {
  bundleKey,
  CA_BUNDLE_PEM,
  ElbBindingsFunction,
  testTargetIp,
} from "./fixtures/bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ELBv2Bindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

interface RouteResult {
  ok: boolean;
  tag: string;
  message?: string;
  targets?: { id?: string; state?: string }[];
  states?: string[];
  location?: string;
}

// Call a fixture route, repeating (bounded) while the response still shows an
// authorization failure — a freshly attached IAM policy is eventually
// consistent and the first invocations after deploy can see AccessDenied.
const callRoute = (method: "GET" | "POST", path: string) =>
  Effect.gen(function* () {
    const request =
      method === "GET"
        ? HttpClientRequest.get(`${baseUrl}${path}`)
        : HttpClientRequest.post(`${baseUrl}${path}`);
    return yield* HttpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.json
          : Effect.fail(
              new Error(`Route ${path} not ready: ${response.status}`),
            ),
      ),
      Effect.map((json) => json as unknown as RouteResult),
      Effect.repeat({
        until: (body): boolean =>
          body.tag !== "AccessDenied" && body.tag !== "AccessDeniedException",
        schedule: Schedule.spaced("3 seconds"),
        times: 10,
      }),
    );
  });

// Deploys a Lambda bound to an unattached ip target group (RegisterTargets /
// DeregisterTargets / DescribeTargetHealth) and an internal ALB
// (Describe/ModifyCapacityReservation), then drives each binding over the
// function URL against live cloud state.
describe("ELBv2 runtime bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      // Phase 1 — the trust store's CA bundle must exist in S3 before the
      // TrustStore resource can be created, and there is no declarative S3
      // object resource yet: deploy the bucket alone, upload the bundle
      // out-of-band, then deploy the full fixture (same logical id, same
      // stack, so phase 2 reconciles the bucket as a no-op).
      const { bucketName } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("ElbBindingsBundleBucket", {
            forceDestroy: true,
          });
          return { bucketName: bucket.bucketName };
        }),
      );
      // beforeAll runs outside the provider env, so the raw distilled call
      // needs the AWS layers (credentials/region) provided explicitly.
      yield* Core.withProviders(
        s3.putObject({
          Bucket: bucketName,
          Key: bundleKey,
          Body: CA_BUNDLE_PEM,
          ContentType: "application/x-pem-file",
        }),
        testOptions,
        sharedStack.name,
      );

      const { fn } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const fn = yield* ElbBindingsFunction;
          return { fn };
        }).pipe(Effect.provide(ElbBindingsFunctionLive)),
      );

      expect(fn.functionUrl).toBeTruthy();
      baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  // The ALB delete blocks until the balancer is fully gone (~2-4 min of ENI
  // release), so give teardown headroom.
  afterAll(sharedStack.destroy(), { timeout: 400_000 });

  test.provider(
    "RegisterTargets -> DescribeTargetHealth -> DeregisterTargets round-trip",
    (_stack) =>
      Effect.gen(function* () {
        const registered = yield* callRoute("POST", "/register");
        // Compare tag AND message so a failure diff surfaces the AWS error.
        expect({ tag: registered.tag, message: registered.message }).toEqual({
          tag: "Success",
          message: undefined,
        });

        const health = yield* callRoute("GET", "/target-health");
        expect(health.ok).toBe(true);
        expect(health.targets?.some((t) => t.id === testTargetIp)).toBe(true);

        const deregistered = yield* callRoute("POST", "/deregister");
        expect(deregistered.tag).toEqual("Success");
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "DescribeCapacityReservation reads the ALB's reservation state",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/capacity");
        expect(body.ok).toBe(true);
        // A fresh ALB has no reservation: the per-AZ state list is empty (or
        // absent) — the successful call is what proves the read grant.
        expect(body.tag).toEqual("Success");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "ModifyCapacityReservation reset is IAM-wired",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/capacity-reset");
        // Resetting a reservation that was never set is accepted (no-op) or
        // rejected with a typed configuration error — never an
        // authorization failure.
        expect([
          "Success",
          "InvalidConfigurationRequestException",
          "CapacityReservationPendingException",
        ]).toContain(body.tag);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "GetTrustStoreCaCertificatesBundle returns a presigned bundle location",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/truststore-bundle");
        expect(body.tag).toEqual("Success");
        expect(body.location).toMatch(/^https:\/\//);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "GetTrustStoreRevocationContent surfaces the typed not-found tag",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/truststore-revocation-missing");
        // The fixture queries a revocation id that was never added — the miss
        // must surface as the typed tag (never an authorization or catch-all
        // failure), proving both the IAM grant and the typed error path.
        expect(body.ok).toBe(false);
        expect(body.tag).toEqual("RevocationIdNotFoundException");
      }),
    { timeout: 60_000 },
  );
});
