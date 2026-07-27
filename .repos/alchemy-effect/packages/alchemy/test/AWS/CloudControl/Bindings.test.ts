import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CloudControlTestFunctionLive, {
  CloudControlTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudControlBindings");

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

describe.sequential("CloudControl Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "CloudControl test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CloudControl test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CloudControlTestFunction;
        }).pipe(Effect.provide(CloudControlTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `CloudControl test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `CloudControl test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 8 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(8);
      }),
    );
  });

  describe("GetResource", () => {
    test.provider(
      "reads the stack-provisioned parameter's live state",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/fixture`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).identifier).toBe(
            "/alchemy-test/cloudcontrol/bindings/fixture",
          );
          expect((response as any).value).toBe("fixture");
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListResources", () => {
    test.provider(
      "discovers the stack-provisioned parameter",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/list`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).count).toBeGreaterThanOrEqual(1);
          expect((response as any).found).toBe(true);
        }),
      { timeout: 90_000 },
    );
  });

  describe("CreateResource + GetResourceRequestStatus", () => {
    test.provider(
      "creates an SSM parameter at runtime and polls it to SUCCESS",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/runtime-create`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ value: "one" }),
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).status).toBe("SUCCESS");
          expect((response as any).value).toBe("one");
        }),
      { timeout: 120_000 },
    );
  });

  describe("UpdateResource", () => {
    test.provider(
      "patches the runtime parameter's value",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/runtime-update`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ value: "two" }),
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).status).toBe("SUCCESS");
          expect((response as any).value).toBe("two");
        }),
      { timeout: 120_000 },
    );
  });

  describe("DeleteResource", () => {
    test.provider(
      "deletes the runtime parameter and observes it gone",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/runtime-delete`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).status).toBe("SUCCESS");
          expect((response as any).gone).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListResourceRequests", () => {
    test.provider(
      "lists recent resource operation requests",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/requests`),
          ).pipe(Effect.flatMap((r) => r.json));
          // The runtime lifecycle above just issued create/update/delete
          // requests, so at least one summary is visible.
          expect((response as any).count).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetResourceRequestStatus", () => {
    test.provider(
      "returns the typed not-found error for an unknown token",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/status-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).found).toBe(false);
        }),
      { timeout: 60_000 },
    );
  });

  describe("CancelResourceRequest", () => {
    test.provider(
      "surfaces the typed not-found error for an unknown token (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/cancel-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).tag).toBe("RequestTokenNotFoundException");
        }),
      { timeout: 60_000 },
    );
  });
});
