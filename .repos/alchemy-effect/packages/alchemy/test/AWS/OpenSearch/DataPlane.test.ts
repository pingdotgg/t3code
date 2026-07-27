import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import OpenSearchDataPlaneFunctionLive, {
  OpenSearchDataPlaneFunction,
} from "./data-plane-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "OpenSearchDataPlane");

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

// Retry only transient 5xx (cold re-init, IAM propagation on the freshly
// attached es:ESHttp* policy); a genuine 4xx surfaces immediately.
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
        Schedule.recurs(8),
      ]),
    }),
  );

// The fixture provisions a real OpenSearch domain (~15-25 minutes, billed
// per instance-hour) — gated behind AWS_TEST_SLOW=1 like the Domain
// lifecycle test. The suite stays skip-clean without the flag.
const describeGated = process.env.AWS_TEST_SLOW
  ? describe.sequential
  : describe.skip;

describeGated("OpenSearch Data Plane", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "OpenSearch data-plane setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "OpenSearch data-plane setup: deploying fixture (domain takes ~15-25 minutes)",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* OpenSearchDataPlaneFunction;
        }).pipe(Effect.provide(OpenSearchDataPlaneFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `OpenSearch data-plane setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `OpenSearch data-plane setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    // Domain provisioning dominates: ~15-25 minutes.
    { timeout: 2_700_000 },
  );

  // Destroy immediately — domains bill while they exist.
  afterAll(sharedStack.destroy(), { timeout: 600_000 });

  describe("binding registration", () => {
    test.provider("all 3 data-plane capabilities initialize", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.bound).toEqual(["reader", "writer", "client"]);
      }),
    );
  });

  describe("DomainWrite", () => {
    test.provider(
      "indexDocument writes a document (es:ESHttpPut)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/doc`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(["created", "updated"]).toContain(response.result);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "bulk applies NDJSON operations (es:ESHttpPost)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/bulk`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.errors).toBe(false);
          expect(response.items).toBe(1);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "updateDocument partially updates (es:ESHttpPost _update)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/update`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(["updated", "noop"]).toContain(response.result);
        }),
      { timeout: 120_000 },
    );
  });

  describe("DomainRead", () => {
    test.provider(
      "getDocument reads back the stored document (es:ESHttpGet)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/doc`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.found).toBe(true);
          expect(response.title).toBe("The Wind Cries Mary");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "getDocument on a missing id is found:false, not an error",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/doc-missing`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.found).toBe(false);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "existsDocument distinguishes present from missing (es:ESHttpHead)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/exists`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.exists).toBe(true);
          expect(response.missing).toBe(false);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "search matches via the source query parameter (es:ESHttpGet)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/search`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.total).toBeGreaterThanOrEqual(1);
          expect(response.firstTitle).toBe("The Wind Cries Mary");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "count counts documents in the index",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/count`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.count).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("DomainReadWrite", () => {
    test.provider(
      "raw request reads cluster health (es:ESHttp*)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/health`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(["green", "yellow", "red"]).toContain(response.status);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "deleteDocument deletes and tolerates not_found (es:ESHttpDelete)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/delete`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.first).toBe("deleted");
          expect(response.second).toBe("not_found");
        }),
      { timeout: 120_000 },
    );
  });
});
