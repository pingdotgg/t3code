import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

import EKSClusterTestFunctionLive, {
  EKSClusterTestFunction,
} from "./fixtures/cluster-bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);
const slowStack = Core.scratchStack(testOptions, "EKSClusterBindings");

// The cluster-scoped bindings (DescribeCluster, the List*/Describe*
// sub-resource operations, insights, updates) need a real EKS control plane
// (~10 minutes to provision) — gated behind the same standing-infrastructure
// envs as Cluster.test.ts: a cluster IAM role (AWS_TEST_EKS_ROLE_ARN) and at
// least two subnets (AWS_TEST_EKS_SUBNET_IDS, comma-separated). An account
// with that standing infrastructure runs this unchanged.
test.provider.skipIf(
  !process.env.AWS_TEST_EKS_ROLE_ARN || !process.env.AWS_TEST_EKS_SUBNET_IDS,
)(
  "cluster-scoped bindings against a live control plane",
  () =>
    Effect.gen(function* () {
      yield* slowStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* slowStack.deploy(
          Effect.gen(function* () {
            return yield* EKSClusterTestFunction;
          }).pipe(Effect.provide(EKSClusterTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        const get = (path: string) =>
          HttpClient.get(`${baseUrl}${path}`).pipe(
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        const bindings = (yield* get("/bindings")) as { bound: string[] };
        expect(bindings.bound).toHaveLength(22);

        // DescribeCluster returns the live control-plane connection info.
        const cluster = (yield* get("/cluster")) as {
          status?: string;
          endpointPresent: boolean;
          caPresent: boolean;
        };
        expect(cluster.status).toBe("ACTIVE");
        expect(cluster.endpointPresent).toBe(true);
        expect(cluster.caPresent).toBe(true);

        // Every enumeration succeeds (a fresh control plane has no
        // sub-resources) — proves each grant + cluster-name injection +
        // response decode.
        const lists = (yield* get("/lists")) as Record<string, number>;
        for (const key of [
          "nodegroups",
          "addons",
          "fargateProfiles",
          "podIdentityAssociations",
          "accessEntries",
          "insights",
          "updates",
          "capabilities",
          "identityProviderConfigs",
        ]) {
          expect(lists[key]).toBeGreaterThanOrEqual(0);
        }

        // Nonexistent sub-resources surface the services' typed tags — an
        // IAM gap or a broken cluster-name injection would surface
        // AccessDeniedException / an opaque 500 instead.
        const probes = (yield* get("/probes")) as Record<string, string>;
        expect(probes.nodegroupTag).toBe("ResourceNotFoundException");
        expect(probes.addonTag).toBe("ResourceNotFoundException");
        expect(probes.fargateProfileTag).toBe("ResourceNotFoundException");
        expect([
          "ResourceNotFoundException",
          "InvalidParameterException",
        ]).toContain(probes.podIdentityTag);
        expect([
          "ResourceNotFoundException",
          "InvalidRequestException",
        ]).toContain(probes.accessEntryTag);
        expect([
          "ResourceNotFoundException",
          "InvalidParameterException",
        ]).toContain(probes.updateTag);
        expect([
          "ResourceNotFoundException",
          "InvalidParameterException",
        ]).toContain(probes.insightTag);
        expect([
          "ResourceNotFoundException",
          "InvalidRequestException",
        ]).toContain(probes.associatedPoliciesTag);
        expect([
          "ResourceNotFoundException",
          "InvalidParameterException",
        ]).toContain(probes.capabilityTag);
        expect([
          "ResourceNotFoundException",
          "InvalidParameterException",
        ]).toContain(probes.identityProviderConfigTag);

        // Insights refresh: kick an on-demand refresh and read its status
        // back. A refresh already in flight surfaces the typed
        // InvalidRequestException — either outcome proves both grants.
        const refresh = (yield* get("/insights-refresh")) as {
          startTag: string;
          describeTag: string;
        };
        expect(typeof refresh.startTag).toBe("string");
        expect(refresh.startTag.length).toBeGreaterThan(0);
        expect(typeof refresh.describeTag).toBe("string");
        expect(refresh.describeTag.length).toBeGreaterThan(0);
      }).pipe(Effect.ensuring(slowStack.destroy().pipe(Effect.orDie)));
    }),
  // cluster create (~10 min) + probes + delete (~10 min) in one test.
  { timeout: 2_400_000 },
);
