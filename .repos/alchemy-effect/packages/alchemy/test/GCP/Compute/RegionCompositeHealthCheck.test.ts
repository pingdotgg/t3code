import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { DEFAULT_NETWORK, defaultNetworkSelfLink } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const region = "us-central1";

const waitUntilGone = (compositeHealthCheck: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getRegionCompositeHealthChecks({
          project,
          region,
          compositeHealthCheck,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

test.provider(
  "getRegionCompositeHealthChecks on a missing check fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getRegionCompositeHealthChecks({
          project,
          region,
          compositeHealthCheck: "alchemy-missing-chc",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "insertRegionCompositeHealthChecks with a missing health source fails with NotFound",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertRegionCompositeHealthChecks({
          project,
          region,
          body: {
            name: "alchemy-chc-probe",
            description: "alchemy entitlement probe",
            healthDestination: `projects/${project}/regions/${region}/forwardingRules/does-not-exist`,
            healthSources: [
              `projects/${project}/regions/${region}/healthSources/does-not-exist`,
            ],
          },
        }),
      );
      expect(error._tag).toEqual("NotFound");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider(
  "create, update, and delete a regional composite health check",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet = yield* GCP.Compute.Subnetwork("IlbSubnet", {
            network: DEFAULT_NETWORK,
            region,
            ipCidrRange: "172.20.1.0/24",
          });
          const check = yield* GCP.Compute.RegionHealthCheck("Probe", {
            region,
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService(
            "IlbBackend",
            {
              region,
              protocol: "TCP",
              loadBalancingScheme: "INTERNAL",
              network: defaultNetworkSelfLink(project),
              healthChecks: [check.selfLink.as<string>()],
              description: "ilb backend",
            },
          );
          const rule = yield* GCP.Compute.ForwardingRule("IlbRule", {
            region,
            loadBalancingScheme: "INTERNAL",
            backendService: backend.selfLink.as<string>(),
            network: defaultNetworkSelfLink(project),
            subnetwork: subnet.selfLink.as<string>(),
            ipProtocol: "TCP",
            allPorts: true,
          });
          const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
            "Agg",
            { region, description: "backend rollup" },
          );
          const source = yield* GCP.Compute.RegionHealthSource("Src", {
            region,
            sources: [backend.selfLink.as<string>()],
            healthAggregationPolicy: policy.selfLink.as<string>(),
            description: "ilb source",
          });
          const composite = yield* GCP.Compute.RegionCompositeHealthCheck(
            "Comp",
            {
              region,
              healthDestination: rule.selfLink.as<string>(),
              healthSources: [source.selfLink.as<string>()],
              description: "and backends",
            },
          );
          return {
            subnet,
            check,
            backend,
            rule,
            policy,
            source,
            composite,
          };
        }),
      );

      expect(created.composite.healthCheckName).toEqual(expect.any(String));
      expect(created.composite.region).toEqual(region);
      expect(created.composite.description).toEqual("and backends");
      expect(created.composite.healthSources.length).toBeGreaterThan(0);

      const fetched = yield* compute.getRegionCompositeHealthChecks({
        project: created.composite.project,
        region,
        compositeHealthCheck: created.composite.healthCheckName,
      });
      expect(fetched.name).toEqual(created.composite.healthCheckName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("and backends");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet = yield* GCP.Compute.Subnetwork("IlbSubnet", {
            subnetworkName: created.subnet.subnetworkName,
            network: DEFAULT_NETWORK,
            region,
            ipCidrRange: "172.20.1.0/24",
          });
          const check = yield* GCP.Compute.RegionHealthCheck("Probe", {
            healthCheckName: created.check.healthCheckName,
            region,
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService(
            "IlbBackend",
            {
              name: created.backend.name,
              region,
              protocol: "TCP",
              loadBalancingScheme: "INTERNAL",
              network: defaultNetworkSelfLink(project),
              healthChecks: [check.selfLink.as<string>()],
              description: "ilb backend",
            },
          );
          const rule = yield* GCP.Compute.ForwardingRule("IlbRule", {
            forwardingRuleName: created.rule.forwardingRuleName,
            region,
            loadBalancingScheme: "INTERNAL",
            backendService: backend.selfLink.as<string>(),
            network: defaultNetworkSelfLink(project),
            subnetwork: subnet.selfLink.as<string>(),
            ipProtocol: "TCP",
            allPorts: true,
          });
          const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
            "Agg",
            {
              policyName: created.policy.policyName,
              region,
              description: "backend rollup",
            },
          );
          const source = yield* GCP.Compute.RegionHealthSource("Src", {
            sourceName: created.source.sourceName,
            region,
            sources: [backend.selfLink.as<string>()],
            healthAggregationPolicy: policy.selfLink.as<string>(),
            description: "ilb source",
          });
          return yield* GCP.Compute.RegionCompositeHealthCheck("Comp", {
            healthCheckName: created.composite.healthCheckName,
            region,
            healthDestination: rule.selfLink.as<string>(),
            healthSources: [source.selfLink.as<string>()],
            description: "updated composite",
          });
        }),
      );

      expect(updated.healthCheckName).toEqual(
        created.composite.healthCheckName,
      );
      expect(updated.description).toEqual("updated composite");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.composite.healthCheckName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 240_000 },
);
