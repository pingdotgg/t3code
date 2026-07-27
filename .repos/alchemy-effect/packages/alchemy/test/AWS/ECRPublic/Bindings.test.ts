import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EcrPublicTestFunctionLive, { EcrPublicTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ECRPublicBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("ECRPublic Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ECRPublic test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ECRPublic test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* EcrPublicTestFunction;
        }).pipe(Effect.provide(EcrPublicTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `ECRPublic test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ECRPublic test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 12 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(12);
      }),
    );
  });

  describe("DescribeRegistries", () => {
    test.provider(
      "reads the account's public registry and alias",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/registries")) as any;
          expect(response.count).toBeGreaterThanOrEqual(1);
          expect(typeof response.alias).toBe("string");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetRegistryCatalogData", () => {
    test.provider(
      "reads the registry catalog data",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/registry-catalog")) as any;
          expect(response.tag).toBe("Ok");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetAuthorizationToken", () => {
    test.provider(
      "mints a registry auth token (proving the sts:GetServiceBearerToken grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/auth-token")) as any;
          expect(response.hasToken).toBe(true);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetRepositoryCatalogData", () => {
    test.provider(
      "reads the fixture repository's gallery metadata (proving repositoryName injection)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/repo-catalog")) as any;
          expect(response.description).toBe(
            "alchemy ECRPublic bindings fixture",
          );
        }),
      { timeout: 60_000 },
    );
  });

  describe("BatchCheckLayerAvailability", () => {
    test.provider(
      "reports a nonexistent layer digest as failed or unavailable",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/check-layers")) as any;
          // ECR Public reports a nonexistent digest either as a per-layer
          // failure or as an UNAVAILABLE layer (observed live: UNAVAILABLE).
          expect(
            response.failures + response.unavailable,
          ).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 60_000 },
    );
  });

  describe("BatchDeleteImage", () => {
    test.provider(
      "reports ImageNotFound for a nonexistent tag (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/delete-missing")) as any;
          expect(response.failureCode).toBe("ImageNotFound");
        }),
      { timeout: 60_000 },
    );
  });

  describe("InitiateLayerUpload + UploadLayerPart + CompleteLayerUpload + PutImage", () => {
    test.provider(
      "pushes a minimal image end-to-end",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/push-flow")) as any;
          expect(response.tag).toBe("Ok");
          expect(response.imageDigest).toContain("sha256:");
        }),
      { timeout: 120_000 },
    );
  });

  describe("DescribeImages", () => {
    test.provider(
      "lists the pushed image",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/images")) as any;
          expect(response.count).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeImageTags", () => {
    test.provider(
      "lists the pushed image's tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/image-tags")) as any;
          expect(response.count).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 60_000 },
    );
  });
});
