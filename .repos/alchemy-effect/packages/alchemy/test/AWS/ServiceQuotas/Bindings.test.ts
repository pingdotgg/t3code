import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ServiceQuotasTestFunctionLive, {
  ServiceQuotasTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ServiceQuotasBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry 5xx only — cold re-inits under parallel load surface as transient
// 500s; a genuine 4xx/assertion failure surfaces immediately.
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
        Schedule.recurs(5),
      ]),
    }),
  );

describe("ServiceQuotas Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ServiceQuotas test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ServiceQuotas test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ServiceQuotasTestFunction;
        }).pipe(Effect.provide(ServiceQuotasTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `ServiceQuotas test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ServiceQuotas test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("GetServiceQuota", () => {
    test.provider(
      "surfaces the typed NoSuchResourceException for a bogus quota",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/quota?service=vpc&quota=L-00000000`,
            ),
          );
          expect(response.status).toBe(404);
          const body = (yield* response.json) as { tag: string };
          expect(body.tag).toBe("NoSuchResourceException");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "reads the applied quota value through the deployed Lambda",
      (_stack) =>
        Effect.gen(function* () {
          // Same account/region as the Lambda — establish the expected
          // behavior out-of-band (some quotas have no applied value and
          // return the typed not-found).
          const expected = yield* servicequotas
            .getServiceQuota({
              ServiceCode: "lambda",
              QuotaCode: "L-B99A9384",
            })
            .pipe(
              Effect.map((r) => r.Quota?.Value),
              Effect.catchTag("NoSuchResourceException", () =>
                Effect.succeed(undefined),
              ),
            );

          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/quota?service=lambda&quota=L-B99A9384`,
            ),
          );
          if (expected === undefined) {
            expect(response.status).toBe(404);
            const body = (yield* response.json) as { tag: string };
            expect(body.tag).toBe("NoSuchResourceException");
          } else {
            expect(response.status).toBe(200);
            const body = (yield* response.json) as {
              quotaCode: string;
              value: number;
            };
            expect(body.quotaCode).toBe("L-B99A9384");
            expect(body.value).toBe(expected);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetAWSDefaultServiceQuota", () => {
    test.provider(
      "reads the AWS default quota value through the deployed Lambda",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band expectation from the same account/region.
          const expected = yield* servicequotas
            .getAWSDefaultServiceQuota({
              ServiceCode: "vpc",
              QuotaCode: "L-F678F1CE",
            })
            .pipe(Effect.map((r) => r.Quota?.Value));

          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/default-quota?service=vpc&quota=L-F678F1CE`,
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            quotaCode: string;
            value: number;
          };
          expect(body.quotaCode).toBe("L-F678F1CE");
          expect(body.value).toBe(expected);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListServices", () => {
    test.provider(
      "lists Service Quotas service codes through the deployed Lambda",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/services`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { serviceCodes: string[] };
          expect(body.serviceCodes.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListServiceQuotas", () => {
    test.provider(
      "lists a service's applied quotas through the deployed Lambda",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/quotas?service=vpc`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { quotaCodes: string[] };
          expect(body.quotaCodes.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListRequestedServiceQuotaChangeHistoryByQuota", () => {
    test.provider(
      "lists a quota's request history through the deployed Lambda",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/history?service=vpc&quota=L-F678F1CE`,
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { count: number };
          expect(body.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("RequestServiceQuotaIncrease", () => {
    test.provider(
      "surfaces the typed NoSuchResourceException for a bogus quota (write-path IAM verified, no request submitted)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(
              `${baseUrl}/request-increase?service=vpc&quota=L-00000000`,
            ),
          );
          expect(response.status).toBe(404);
          const body = (yield* response.json) as { tag: string };
          expect(body.tag).toBe("NoSuchResourceException");
        }),
      { timeout: 120_000 },
    );
  });
});
