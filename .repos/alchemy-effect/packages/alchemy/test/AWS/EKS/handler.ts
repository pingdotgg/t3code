import * as EKS from "@/AWS/EKS";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class EksTestFunction extends Lambda.Function<Lambda.Function>()(
  "EksTestFunction",
) {}

/**
 * Account-level EKS bindings fixture. The cluster-scoped bindings
 * (`DescribeCluster`, `ListNodegroups`, …) require a live EKS control plane
 * (~10+ minutes to provision) and are exercised by the env-gated
 * `ClusterBindings.test.ts` fixture instead. The five account-scoped
 * discovery/catalog bindings need no cluster at all, so this fixture proves
 * their init + IAM + runtime wiring ungated.
 */
export default EksTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const listClusters = yield* EKS.ListClusters();
    const listAccessPolicies = yield* EKS.ListAccessPolicies();
    const describeClusterVersions = yield* EKS.DescribeClusterVersions();
    const describeAddonVersions = yield* EKS.DescribeAddonVersions();
    const describeAddonConfiguration = yield* EKS.DescribeAddonConfiguration();

    const bound = {
      listClusters,
      listAccessPolicies,
      describeClusterVersions,
      describeAddonVersions,
      describeAddonConfiguration,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/clusters") {
          const { clusters } = yield* listClusters();
          return yield* HttpServerResponse.json({
            count: (clusters ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/access-policies") {
          const { accessPolicies } = yield* listAccessPolicies();
          return yield* HttpServerResponse.json({
            count: (accessPolicies ?? []).length,
            names: (accessPolicies ?? []).map((policy) => policy.name),
          });
        }

        if (request.method === "GET" && pathname === "/cluster-versions") {
          const { clusterVersions } = yield* describeClusterVersions({
            defaultOnly: true,
          });
          return yield* HttpServerResponse.json({
            count: (clusterVersions ?? []).length,
            defaultVersion: clusterVersions?.[0]?.clusterVersion,
          });
        }

        if (request.method === "GET" && pathname === "/addon-versions") {
          const { addons } = yield* describeAddonVersions({
            addonName: "vpc-cni",
            maxResults: 1,
          });
          return yield* HttpServerResponse.json({
            count: (addons ?? []).length,
            addonName: addons?.[0]?.addonName,
          });
        }

        // Chains two catalog bindings: resolve a live vpc-cni version via
        // DescribeAddonVersions, then fetch that version's configuration
        // JSON schema via DescribeAddonConfiguration.
        if (request.method === "GET" && pathname === "/addon-schema") {
          const { addons } = yield* describeAddonVersions({
            addonName: "vpc-cni",
            maxResults: 1,
          });
          const addonVersion = addons?.[0]?.addonVersions?.[0]?.addonVersion;
          if (!addonVersion) {
            return yield* HttpServerResponse.json(
              { error: "no vpc-cni addon version found" },
              { status: 404 },
            );
          }
          const { configurationSchema } = yield* describeAddonConfiguration({
            addonName: "vpc-cni",
            addonVersion,
          });
          return yield* HttpServerResponse.json({
            addonVersion,
            hasSchema:
              typeof configurationSchema === "string" &&
              configurationSchema.length > 0,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        EKS.ListClustersHttp,
        EKS.ListAccessPoliciesHttp,
        EKS.DescribeClusterVersionsHttp,
        EKS.DescribeAddonVersionsHttp,
        EKS.DescribeAddonConfigurationHttp,
      ),
    ),
  ),
);
