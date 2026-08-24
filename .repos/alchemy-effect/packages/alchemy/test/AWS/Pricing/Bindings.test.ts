import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as pricing from "@distilled.cloud/aws/pricing";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import PricingTestFunctionLive, { PricingTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PricingBindings");

// The Price List Query API is only served from us-east-1 — pin the region for
// out-of-band probes made directly from the test process.
const withPricingRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

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

// Retry transient 5xx only; a genuine 4xx/assertion failure surfaces
// immediately.
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

// Ungated probes against the real API (read-only, near-zero cost).
//
// Observed live behavior: an unknown ServiceCode does NOT error on ANY
// pricing operation (GetProducts / DescribeServices / GetAttributeValues all
// succeed with empty results). The API's documented NotFoundException is not
// reachable via bogus codes; a constraint violation (MaxResults=0) is the
// cheap deterministic typed error, proving distilled's error mapping and the
// us-east-1 region pin.
test.provider(
  "getProducts with a bogus ServiceCode succeeds with an empty PriceList",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* withPricingRegion(
        pricing.getProducts({
          ServiceCode: "AlchemyBogusServiceCodeProbe",
          MaxResults: 1,
        }),
      );

      expect(result.PriceList ?? []).toHaveLength(0);
    }),
  { timeout: 60_000 },
);

test.provider(
  "getProducts with an out-of-range MaxResults returns a typed InvalidParameterException",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withPricingRegion(
          pricing.getProducts({
            ServiceCode: "AmazonEC2",
            MaxResults: 0,
          }),
        ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("InvalidParameterException");
      }
    }),
  { timeout: 60_000 },
);

describe("Pricing Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Pricing test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Pricing test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* PricingTestFunction;
        }).pipe(Effect.provide(PricingTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `Pricing test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Pricing test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("GetProducts", () => {
    test.provider(
      "returns a non-empty price list for AmazonEC2 t3.micro",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/products`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            formatVersion: string | undefined;
            firstServiceCode: string | undefined;
            firstInstanceType: string | undefined;
          };

          expect(response.count).toBeGreaterThan(0);
          expect(response.firstServiceCode).toBe("AmazonEC2");
          expect(response.firstInstanceType).toBe("t3.micro");
        }),
      { timeout: 120_000 },
    );
  });

  describe("DescribeServices", () => {
    test.provider(
      "describes AmazonEC2 with its filterable attribute names",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/services`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            services: Array<{
              serviceCode: string;
              attributeNameCount: number;
            }>;
          };

          expect(response.services.length).toBe(1);
          expect(response.services[0].serviceCode).toBe("AmazonEC2");
          expect(response.services[0].attributeNameCount).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListPriceLists + GetPriceListFileUrl", () => {
    test.provider(
      "lists EC2 price lists and presigns a bulk file URL",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/price-list-file-url`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            priceListArn: string;
            regionCode: string | undefined;
            currencyCode: string | undefined;
            fileFormats: string[];
            url: string | undefined;
          };

          expect(response.count).toBeGreaterThan(0);
          expect(response.priceListArn).toContain("arn:aws:pricing:");
          expect(response.regionCode).toBe("us-east-1");
          expect(response.currencyCode).toBe("USD");
          expect(response.fileFormats.length).toBeGreaterThan(0);
          expect(response.url).toMatch(/^https:\/\//);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetAttributeValues", () => {
    test.provider(
      "lists volumeType attribute values for AmazonEC2",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/attribute-values`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            values: string[];
          };

          expect(response.values.length).toBeGreaterThan(0);
          // gp2/gp3 are stable, long-standing EBS volume types.
          expect(
            response.values.some((value) =>
              value.startsWith("General Purpose"),
            ),
          ).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });
});
