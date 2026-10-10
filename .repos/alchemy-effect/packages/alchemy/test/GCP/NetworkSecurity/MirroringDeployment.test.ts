import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsMirroringDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsMirroringDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsMirroringDeployments({
          name: `projects/${project}/locations/us-central1-a/mirroringDeployments/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a mirroring deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
            description: "mirroring deployment vpc",
          });
          const subnet = yield* GCP.Compute.Subnetwork("Subnet", {
            region: "us-central1",
            network: vpc.selfLink.as<string>(),
            ipCidrRange: "10.10.0.0/24",
          });
          const health = yield* GCP.Compute.HealthCheck("Tcp", {
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService("Collector", {
            region: "us-central1",
            protocol: "UDP",
            loadBalancingScheme: "INTERNAL",
            healthChecks: [health.selfLink.as<string>()],
          });
          const rule = yield* GCP.Compute.ForwardingRule("CollectorRule", {
            region: "us-central1",
            loadBalancingScheme: "INTERNAL",
            ipProtocol: "UDP",
            allPorts: true,
            network: vpc.selfLink.as<string>(),
            subnetwork: subnet.selfLink.as<string>(),
            backendService: backend.selfLink.as<string>(),
            isMirroringCollector: true,
          });
          const collectors =
            yield* GCP.NetworkSecurity.MirroringDeploymentGroup("Collectors", {
              network: vpc.selfLink.as<string>(),
            });
          const deployment = yield* GCP.NetworkSecurity.MirroringDeployment(
            "ZoneA",
            {
              location: "us-central1-a",
              mirroringDeploymentGroup: collectors.name,
              forwardingRule: rule.selfLink.as<string>(),
              description: "mirroring dep a",
              labels: { env: "test" },
            },
          );
          return { vpc, subnet, health, backend, rule, collectors, deployment };
        }),
      );

      expect(created.deployment.name).toContain("/mirroringDeployments/");
      expect(created.deployment.location).toEqual("us-central1-a");
      expect(created.deployment.description).toEqual("mirroring dep a");
      expect(created.deployment.labels).toMatchObject({ env: "test" });
      expect(created.deployment.mirroringDeploymentGroup).toEqual(
        created.collectors.name,
      );

      const fetched =
        yield* networksecurity.getProjectsLocationsMirroringDeployments({
          name: created.deployment.name,
        });
      expect(fetched.name).toEqual(created.deployment.name);
      expect(fetched.description).toEqual("mirroring dep a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
            description: "mirroring deployment vpc",
          });
          const subnet = yield* GCP.Compute.Subnetwork("Subnet", {
            subnetworkName: created.subnet.subnetworkName,
            region: "us-central1",
            network: vpc.selfLink.as<string>(),
            ipCidrRange: "10.10.0.0/24",
          });
          const health = yield* GCP.Compute.HealthCheck("Tcp", {
            healthCheckName: created.health.healthCheckName,
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService("Collector", {
            name: created.backend.name,
            region: "us-central1",
            protocol: "UDP",
            loadBalancingScheme: "INTERNAL",
            healthChecks: [health.selfLink.as<string>()],
          });
          const rule = yield* GCP.Compute.ForwardingRule("CollectorRule", {
            forwardingRuleName: created.rule.forwardingRuleName,
            region: "us-central1",
            loadBalancingScheme: "INTERNAL",
            ipProtocol: "UDP",
            allPorts: true,
            network: vpc.selfLink.as<string>(),
            subnetwork: subnet.selfLink.as<string>(),
            backendService: backend.selfLink.as<string>(),
            isMirroringCollector: true,
          });
          const collectors =
            yield* GCP.NetworkSecurity.MirroringDeploymentGroup("Collectors", {
              mirroringDeploymentGroupId:
                created.collectors.mirroringDeploymentGroupId,
              network: vpc.selfLink.as<string>(),
            });
          const deployment = yield* GCP.NetworkSecurity.MirroringDeployment(
            "ZoneA",
            {
              mirroringDeploymentId: created.deployment.mirroringDeploymentId,
              location: "us-central1-a",
              mirroringDeploymentGroup: collectors.name,
              forwardingRule: rule.selfLink.as<string>(),
              description: "mirroring dep b",
              labels: { env: "prod", role: "nsi" },
            },
          );
          return { vpc, subnet, health, backend, rule, collectors, deployment };
        }),
      );

      expect(updated.deployment.name).toEqual(created.deployment.name);
      expect(updated.deployment.description).toEqual("mirroring dep b");
      expect(updated.deployment.labels).toMatchObject({
        env: "prod",
        role: "nsi",
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.deployment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 900_000,
  },
);
