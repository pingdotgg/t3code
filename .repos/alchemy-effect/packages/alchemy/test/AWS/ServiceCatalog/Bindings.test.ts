import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import {
  Portfolio,
  PortfolioProductAssociation,
  PrincipalPortfolioAssociation,
  Product,
} from "@/AWS/ServiceCatalog";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ServiceCatalogTestFunctionLive, {
  ServiceCatalogTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ServiceCatalogBindings");

// Deterministic provisioned-product name — the physical anchor for
// idempotency and cross-run cleanup.
const PP_NAME = "alchemy-sc-bindings-pp";

// Minimal valid CloudFormation template (a no-op resource) so provisioning
// needs no resource permissions beyond CloudFormation itself. Generated
// once and inlined — never at deploy time.
const TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "alchemy Service Catalog bindings test template",
  Resources: {
    NoOp: { Type: "AWS::CloudFormation::WaitConditionHandle" },
  },
});

class ProvisionedProductStillExists extends Data.TaggedError(
  "ScBindingsProvisionedProductStillExists",
)<{ name: string }> {}

// beforeAll/afterAll hooks run without the providers layer (unlike
// `test.provider` bodies) — out-of-band distilled calls need it provided
// explicitly.
const outOfBand = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

/**
 * Out-of-band cleanup: terminate any provisioned product a previous run
 * left behind (its terminate token derives from the instance's unique ID
 * so a retried cleanup converges) and wait — bounded — until it is gone.
 */
const ensureProvisionedProductGone = Effect.gen(function* () {
  const existing = yield* servicecatalog
    .describeProvisionedProduct({ Name: PP_NAME })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  const id = existing?.ProvisionedProductDetail?.Id;
  if (id === undefined) return;
  yield* servicecatalog
    .terminateProvisionedProduct({
      ProvisionedProductId: id,
      TerminateToken: id.replaceAll(/[^a-zA-Z0-9_-]/g, ""),
      IgnoreErrors: true,
    })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
  yield* servicecatalog.describeProvisionedProduct({ Name: PP_NAME }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ProvisionedProductStillExists({ name: PP_NAME })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e): boolean =>
        e._tag === "ScBindingsProvisionedProductStillExists",
      schedule: Schedule.max([
        Schedule.fixed("4 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
});

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let productId: string;
let provisioningArtifactId: string;

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

describe.sequential("ServiceCatalog Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ServiceCatalog test setup: destroying previous resources",
      );
      yield* outOfBand(ensureProvisionedProductGone);
      yield* sharedStack.destroy();

      // Phase 1: a bucket to host the CloudFormation template — it must
      // exist in S3 before the product can be created.
      const phase1 = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("ScBindingsTemplateBucket", {
            forceDestroy: true,
          });
          return { bucketName: bucket.bucketName, region: bucket.region };
        }),
      );
      yield* outOfBand(
        s3.putObject({
          Bucket: phase1.bucketName,
          Key: "bindings-template.json",
          Body: new TextEncoder().encode(TEMPLATE),
          ContentType: "application/json",
        }),
      );
      const templateUrl = `https://${phase1.bucketName}.s3.${phase1.region}.amazonaws.com/bindings-template.json`;

      // Phase 2: portfolio + product + the fixture Lambda, whose execution
      // role becomes the portfolio principal so the function's runtime
      // bindings can browse and provision.
      yield* Effect.logInfo("ServiceCatalog test setup: deploying fixture");
      const deployed = yield* sharedStack.deploy(
        Effect.gen(function* () {
          yield* Bucket("ScBindingsTemplateBucket", { forceDestroy: true });
          const portfolio = yield* Portfolio("ScBindingsPortfolio", {
            providerName: "alchemy-tests",
          });
          const product = yield* Product("ScBindingsProduct", {
            owner: "alchemy-tests",
            description: "bindings test product",
            provisioningArtifact: { templateUrl },
          });
          yield* PortfolioProductAssociation("ScBindingsProductInPortfolio", {
            portfolioId: portfolio.portfolioId,
            productId: product.productId,
          });
          const fn = yield* ServiceCatalogTestFunction;
          yield* PrincipalPortfolioAssociation("ScBindingsFunctionAccess", {
            portfolioId: portfolio.portfolioId,
            principalArn: fn.roleArn,
          });
          return {
            functionUrl: fn.functionUrl,
            productId: product.productId,
            provisioningArtifactId: product.provisioningArtifactId,
          };
        }).pipe(Effect.provide(ServiceCatalogTestFunctionLive)),
      );

      expect(deployed.functionUrl).toBeTruthy();
      baseUrl = deployed.functionUrl!.replace(/\/+$/, "");
      productId = deployed.productId;
      provisioningArtifactId = deployed.provisioningArtifactId;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `ServiceCatalog test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ServiceCatalog test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(
    Effect.gen(function* () {
      // The provisioned product must be gone before the product/portfolio
      // can be deleted.
      yield* outOfBand(ensureProvisionedProductGone);
      yield* sharedStack.destroy();
    }),
    { timeout: 180_000 },
  );

  describe("binding registration", () => {
    test.provider("all 15 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as any;
        expect(response.bound).toHaveLength(15);
      }),
    );
  });

  describe("SearchProducts", () => {
    test.provider(
      "searches the caller's product view",
      (_stack) =>
        Effect.gen(function* () {
          // Search indexing can lag well behind the principal association —
          // assert the binding round-trips (poll past IAM propagation);
          // catalog visibility is asserted via ListLaunchPaths below.
          const response = (yield* getJson("/search").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean => (r as any).tag === "Ok",
              times: 20,
            }),
          )) as any;
          expect(response.tag).toBe("Ok");
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeProduct + ListLaunchPaths + DescribeProvisioningParameters", () => {
    test.provider(
      "browses the associated product through the portfolio",
      (_stack) =>
        Effect.gen(function* () {
          // The principal association is eventually consistent — poll the
          // launch paths (bounded) until the portfolio grants access.
          const paths = (yield* getJson(
            `/launch-paths?productId=${productId}`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean =>
                (r as any).tag === "Ok" && (r as any).count > 0,
              times: 30,
            }),
          )) as any;
          expect(paths.tag).toBe("Ok");
          expect(paths.count).toBeGreaterThan(0);

          const product = (yield* getJson(`/product?id=${productId}`)) as any;
          expect(product.tag).toBe("Ok");
          expect(typeof product.name).toBe("string");

          const params = (yield* getJson(
            `/params?productId=${productId}&artifactId=${provisioningArtifactId}&pathId=${paths.pathId}`,
          )) as any;
          expect(params.tag).toBe("Ok");
          // the no-op template declares no parameters
          expect(params.count).toBe(0);
        }),
      { timeout: 180_000 },
    );
  });

  describe("ProvisionProduct + DescribeRecord + provisioned-product reads + TerminateProvisionedProduct", () => {
    test.provider(
      "provisions, tracks, reads outputs, and terminates a product",
      (_stack) =>
        Effect.gen(function* () {
          // request tokens are per-attempt idempotency tokens, not physical
          // names — the deterministic anchor is PP_NAME.
          const runToken = crypto.randomUUID().replaceAll("-", "");

          // Retry-safety: a previous (failed) attempt may have left the
          // provisioned product behind — terminate it first so provisioning
          // with the deterministic name converges.
          const existing = (yield* getJson(`/pp?name=${PP_NAME}`)) as any;
          if (existing.tag === "Ok") {
            yield* getJson(`/terminate?name=${PP_NAME}&token=c${runToken}`);
            yield* getJson(`/pp?name=${PP_NAME}`).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("4 seconds"),
                until: (r): boolean =>
                  (r as any).tag === "ResourceNotFoundException",
                times: 30,
              }),
            );
          }

          // Provision — retry (bounded) while portfolio access propagates;
          // the constant token makes retried calls converge on one record.
          const provisioned = (yield* getJson(
            `/provision?productId=${productId}&artifactId=${provisioningArtifactId}&name=${PP_NAME}&token=p${runToken}`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean => (r as any).tag === "Ok",
              times: 20,
            }),
          )) as any;
          expect(provisioned.tag).toBe("Ok");
          expect(provisioned.recordId).toMatch(/^rec-/);

          // DescribeRecord — poll the record to completion.
          const record = (yield* getJson(
            `/record?id=${provisioned.recordId}`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("4 seconds"),
              until: (r): boolean =>
                (r as any).status === "SUCCEEDED" ||
                (r as any).status === "FAILED",
              times: 30,
            }),
          )) as any;
          expect(record.errors ?? []).toEqual([]);
          expect(record.status).toBe("SUCCEEDED");

          // DescribeProvisionedProduct — available by name.
          const pp = (yield* getJson(`/pp?name=${PP_NAME}`)) as any;
          expect(pp.tag).toBe("Ok");
          expect(pp.status).toBe("AVAILABLE");
          expect(pp.provisionedProductId).toMatch(/^pp-/);

          // SearchProvisionedProducts sees it.
          const searched = (yield* getJson("/search-pp")) as any;
          expect(searched.tag).toBe("Ok");
          expect(searched.count).toBeGreaterThan(0);

          // GetProvisionedProductOutputs — the no-op template declares no
          // outputs, but Service Catalog injects `CloudformationStackARN`.
          const outputs = (yield* getJson(`/outputs?name=${PP_NAME}`)) as any;
          expect(outputs.tag).toBe("Ok");
          expect(outputs.count).toBeGreaterThanOrEqual(0);

          // ListRecordHistory includes the provision record.
          const history = (yield* getJson("/history")) as any;
          expect(history.tag).toBe("Ok");
          expect(history.count).toBeGreaterThan(0);

          // Terminate and wait — bounded — until the provisioned product
          // is gone.
          const terminated = (yield* getJson(
            `/terminate?name=${PP_NAME}&token=t${runToken}`,
          )) as any;
          expect(terminated.tag).toBe("Ok");
          const gone = (yield* getJson(`/pp?name=${PP_NAME}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("4 seconds"),
              until: (r): boolean =>
                (r as any).tag === "ResourceNotFoundException",
              times: 30,
            }),
          )) as any;
          expect(gone.tag).toBe("ResourceNotFoundException");
        }),
      { timeout: 300_000 },
    );
  });

  describe("UpdateProvisionedProduct", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent provisioned product (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/update-nonexistent")) as any;
          expect([
            "ResourceNotFoundException",
            "InvalidParametersException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListStackInstancesForProvisionedProduct", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent provisioned product (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/stack-instances-nonexistent",
          )) as any;
          expect([
            "ResourceNotFoundException",
            "InvalidParametersException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeServiceActionExecutionParameters", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent service action (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/service-action-params-nonexistent",
          )) as any;
          expect([
            "ResourceNotFoundException",
            "InvalidParametersException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ExecuteProvisionedProductServiceAction", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent service action (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/execute-nonexistent")) as any;
          expect([
            "ProvisionedProductNotFound",
            // pre-patch distilled lib delivers the raw tag
            "ValidationException",
            "ResourceNotFoundException",
            "InvalidParametersException",
            "InvalidStateException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });
});
