import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import EksTestFunctionLive, { EksTestFunction } from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EksBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? Effect.fail(new Error(`transient ${response.status}`))
        : Effect.succeed(response),
    ),
    // The fixture occasionally answers a transient 5xx under load (cold
    // re-init, IAM propagation on the freshly attached policy). Bounded retry.
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
    Effect.flatMap((response) => response.json),
  );

// The account-scoped EKS bindings need no cluster: ListClusters,
// ListAccessPolicies, DescribeClusterVersions, DescribeAddonVersions, and
// DescribeAddonConfiguration all answer against the account/region and the
// AWS-managed catalogs. The cluster-scoped bindings are exercised by the
// env-gated ClusterBindings.test.ts (an EKS control plane takes ~10+ minutes
// to provision — far beyond the routine test budget).
describe.sequential("EKS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("EKS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("EKS test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* EksTestFunction;
        }).pipe(Effect.provide(EksTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `EKS test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `EKS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
    }),
    { timeout: 120_000 },
  );

  describe("binding registration", () => {
    test.provider("all 5 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(5);
        expect(response.bound).toContain("listClusters");
        expect(response.bound).toContain("describeAddonConfiguration");
      }),
    );
  });

  describe("ListClusters", () => {
    test.provider("enumerates the account's clusters", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/clusters")) as { count: number };
        expect(typeof response.count).toBe("number");
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListAccessPolicies", () => {
    test.provider("returns the AWS-managed access policy catalog", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/access-policies")) as {
          count: number;
          names: string[];
        };
        // AWS ships a standing set of managed policies
        // (AmazonEKSAdminPolicy, AmazonEKSViewPolicy, …).
        expect(response.count).toBeGreaterThan(0);
        expect(response.names).toContain("AmazonEKSViewPolicy");
      }),
    );
  });

  describe("DescribeClusterVersions", () => {
    test.provider("reports a default Kubernetes version", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/cluster-versions")) as {
          count: number;
          defaultVersion?: string;
        };
        expect(response.count).toBeGreaterThan(0);
        expect(response.defaultVersion).toMatch(/^\d+\.\d+$/);
      }),
    );
  });

  describe("DescribeAddonVersions", () => {
    test.provider("finds the vpc-cni add-on in the catalog", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/addon-versions")) as {
          count: number;
          addonName?: string;
        };
        expect(response.count).toBe(1);
        expect(response.addonName).toBe("vpc-cni");
      }),
    );
  });

  describe("DescribeAddonConfiguration", () => {
    test.provider(
      "reads the configuration schema for a live vpc-cni version",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/addon-schema")) as {
            addonVersion?: string;
            hasSchema?: boolean;
          };
          expect(response.addonVersion).toBeTruthy();
          expect(response.hasSchema).toBe(true);
        }),
    );
  });
});
