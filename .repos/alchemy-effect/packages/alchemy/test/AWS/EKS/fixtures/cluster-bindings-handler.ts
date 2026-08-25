import * as EKS from "@/AWS/EKS";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "cluster-bindings-handler.ts");

// The gated test supplies standing infrastructure via env (same convention as
// Cluster.test.ts). The fallbacks keep the module importable when the test is
// skipped — the fixture is only ever deployed when the env vars are set.
const roleArn =
  process.env.AWS_TEST_EKS_ROLE_ARN ??
  "arn:aws:iam::000000000000:role/placeholder";
const subnetIds = (process.env.AWS_TEST_EKS_SUBNET_IDS ?? "").split(",");

// Well-formed-but-nonexistent identifiers: each /probes call drives a
// cluster-scoped binding against one so the route proves the IAM grant, the
// cluster-name injection, and the typed error decode without provisioning the
// sub-resource.
const BOGUS = "alchemy-nonexistent-probe";
const BOGUS_PRINCIPAL_ARN =
  "arn:aws:iam::000000000000:role/alchemy-nonexistent-probe";

export class EKSClusterTestFunction extends Lambda.Function<Lambda.Function>()(
  "EKSClusterTestFunction",
) {}

/**
 * Cluster-scoped binding fixture: deploys a real EKS control plane (~10 min —
 * gated behind AWS_TEST_EKS_ROLE_ARN + AWS_TEST_EKS_SUBNET_IDS) and a Lambda
 * bound to it with every cluster-scoped EKS binding.
 */
export default EKSClusterTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const cluster = yield* EKS.Cluster("BindingsCluster", {
      clusterName: "alchemy-test-eks-bindings",
      roleArn,
      resourcesVpcConfig: {
        subnetIds,
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
      },
    });

    const describeCluster = yield* EKS.DescribeCluster(cluster);
    const listNodegroups = yield* EKS.ListNodegroups(cluster);
    const listAddons = yield* EKS.ListAddons(cluster);
    const listFargateProfiles = yield* EKS.ListFargateProfiles(cluster);
    const listPodIdentityAssociations =
      yield* EKS.ListPodIdentityAssociations(cluster);
    const listAccessEntries = yield* EKS.ListAccessEntries(cluster);
    const listInsights = yield* EKS.ListInsights(cluster);
    const listUpdates = yield* EKS.ListUpdates(cluster);
    const listCapabilities = yield* EKS.ListCapabilities(cluster);
    const listIdentityProviderConfigs =
      yield* EKS.ListIdentityProviderConfigs(cluster);
    const listAssociatedAccessPolicies =
      yield* EKS.ListAssociatedAccessPolicies(cluster);
    const describeNodegroup = yield* EKS.DescribeNodegroup(cluster);
    const describeAddon = yield* EKS.DescribeAddon(cluster);
    const describeFargateProfile = yield* EKS.DescribeFargateProfile(cluster);
    const describePodIdentityAssociation =
      yield* EKS.DescribePodIdentityAssociation(cluster);
    const describeAccessEntry = yield* EKS.DescribeAccessEntry(cluster);
    const describeUpdate = yield* EKS.DescribeUpdate(cluster);
    const describeInsight = yield* EKS.DescribeInsight(cluster);
    const describeCapability = yield* EKS.DescribeCapability(cluster);
    const describeIdentityProviderConfig =
      yield* EKS.DescribeIdentityProviderConfig(cluster);
    const describeInsightsRefresh = yield* EKS.DescribeInsightsRefresh(cluster);
    const startInsightsRefresh = yield* EKS.StartInsightsRefresh(cluster);

    const bound = {
      describeCluster,
      listNodegroups,
      listAddons,
      listFargateProfiles,
      listPodIdentityAssociations,
      listAccessEntries,
      listInsights,
      listUpdates,
      listAssociatedAccessPolicies,
      describeNodegroup,
      describeAddon,
      describeFargateProfile,
      describePodIdentityAssociation,
      describeAccessEntry,
      describeUpdate,
      describeInsight,
      listCapabilities,
      listIdentityProviderConfigs,
      describeCapability,
      describeIdentityProviderConfig,
      describeInsightsRefresh,
      startInsightsRefresh,
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

        if (request.method === "GET" && pathname === "/cluster") {
          const result = yield* describeCluster();
          return yield* HttpServerResponse.json({
            status: result.cluster?.status,
            endpointPresent: typeof result.cluster?.endpoint === "string",
            caPresent:
              typeof result.cluster?.certificateAuthority?.data === "string",
          });
        }

        if (request.method === "GET" && pathname === "/lists") {
          // A fresh control plane has none of these — an empty page from each
          // proves the grant + clusterName injection + response decode.
          const nodegroups = yield* listNodegroups();
          const addons = yield* listAddons();
          const fargateProfiles = yield* listFargateProfiles();
          const podIdentityAssociations = yield* listPodIdentityAssociations();
          const accessEntries = yield* listAccessEntries();
          const insights = yield* listInsights();
          const updates = yield* listUpdates();
          const capabilities = yield* listCapabilities();
          const identityProviderConfigs = yield* listIdentityProviderConfigs();
          return yield* HttpServerResponse.json({
            nodegroups: (nodegroups.nodegroups ?? []).length,
            addons: (addons.addons ?? []).length,
            fargateProfiles: (fargateProfiles.fargateProfileNames ?? []).length,
            podIdentityAssociations: (
              podIdentityAssociations.associations ?? []
            ).length,
            accessEntries: (accessEntries.accessEntries ?? []).length,
            insights: (insights.insights ?? []).length,
            updates: (updates.updateIds ?? []).length,
            capabilities: (capabilities.capabilities ?? []).length,
            identityProviderConfigs: (
              identityProviderConfigs.identityProviderConfigs ?? []
            ).length,
          });
        }

        if (request.method === "GET" && pathname === "/probes") {
          // Nonexistent sub-resources must surface the service's typed
          // not-found tags — an IAM gap or a broken cluster-name injection
          // would surface AccessDeniedException / a 500 instead.
          const nodegroupTag = yield* describeNodegroup({
            nodegroupName: BOGUS,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const addonTag = yield* describeAddon({ addonName: BOGUS }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const fargateProfileTag = yield* describeFargateProfile({
            fargateProfileName: BOGUS,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const podIdentityTag = yield* describePodIdentityAssociation({
            associationId: `a-${BOGUS}`,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const accessEntryTag = yield* describeAccessEntry({
            principalArn: BOGUS_PRINCIPAL_ARN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidRequestException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const updateTag = yield* describeUpdate({
            updateId: "00000000-0000-0000-0000-000000000000",
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const insightTag = yield* describeInsight({
            id: "00000000-0000-0000-0000-000000000000",
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const associatedPoliciesTag = yield* listAssociatedAccessPolicies({
            principalArn: BOGUS_PRINCIPAL_ARN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidRequestException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const capabilityTag = yield* describeCapability({
            capabilityName: BOGUS,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const identityProviderConfigTag =
            yield* describeIdentityProviderConfig({
              identityProviderConfig: { type: "oidc", name: BOGUS },
            }).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                ["ResourceNotFoundException", "InvalidParameterException"],
                (e) => Effect.succeed(e._tag),
              ),
            );
          return yield* HttpServerResponse.json({
            nodegroupTag,
            addonTag,
            fargateProfileTag,
            podIdentityTag,
            accessEntryTag,
            updateTag,
            insightTag,
            associatedPoliciesTag,
            capabilityTag,
            identityProviderConfigTag,
          });
        }

        if (request.method === "GET" && pathname === "/insights-refresh") {
          // Kick an on-demand refresh, then read its status back — proves both
          // grants. A refresh already in flight surfaces the service's typed
          // InvalidRequestException, which proves the same wiring.
          const startTag = yield* startInsightsRefresh().pipe(
            Effect.map((r) => r.status ?? "STARTED"),
            Effect.catchTag(
              ["InvalidRequestException", "ResourceNotFoundException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const describeTag = yield* describeInsightsRefresh().pipe(
            Effect.map((r) => r.status ?? "UNKNOWN"),
            Effect.catchTag(
              ["InvalidRequestException", "ResourceNotFoundException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ startTag, describeTag });
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
        EKS.DescribeClusterHttp,
        EKS.ListNodegroupsHttp,
        EKS.ListAddonsHttp,
        EKS.ListFargateProfilesHttp,
        EKS.ListPodIdentityAssociationsHttp,
        EKS.ListAccessEntriesHttp,
        EKS.ListInsightsHttp,
        EKS.ListUpdatesHttp,
        EKS.ListAssociatedAccessPoliciesHttp,
        EKS.DescribeNodegroupHttp,
        EKS.DescribeAddonHttp,
        EKS.DescribeFargateProfileHttp,
        EKS.DescribePodIdentityAssociationHttp,
        EKS.DescribeAccessEntryHttp,
        EKS.DescribeUpdateHttp,
        EKS.DescribeInsightHttp,
        EKS.ListCapabilitiesHttp,
        EKS.ListIdentityProviderConfigsHttp,
        EKS.DescribeCapabilityHttp,
        EKS.DescribeIdentityProviderConfigHttp,
        EKS.DescribeInsightsRefreshHttp,
        EKS.StartInsightsRefreshHttp,
      ),
    ),
  ),
);
