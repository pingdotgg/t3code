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
  networksecurity.getProjectsLocationsInterceptDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsInterceptDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsInterceptDeployments({
          name: `projects/${project}/locations/us-central1-a/interceptDeployments/alchemy-missing`,
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
  "create, update, and delete an intercept deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
            description: "intercept deployment vpc",
          });
          const subnet = yield* GCP.Compute.Subnetwork("Subnet", {
            region: "us-central1",
            network: vpc.networkName,
            ipCidrRange: "10.90.0.0/24",
            description: "intercept deployment subnet",
          });
          const healthCheck = yield* GCP.Compute.RegionHealthCheck("Hc", {
            region: "us-central1",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
            description: "intercept deployment hc",
          });
          const backend = yield* GCP.Compute.RegionBackendService("Backend", {
            region: "us-central1",
            protocol: "UDP",
            loadBalancingScheme: "INTERNAL",
            network: vpc.selfLink,
            healthChecks: [healthCheck.selfLink.as<string>()],
            description: "intercept deployment backend",
          });
          const rule = yield* GCP.Compute.ForwardingRule("Rule", {
            region: "us-central1",
            loadBalancingScheme: "INTERNAL",
            ipProtocol: "UDP",
            ports: ["6081"],
            network: vpc.selfLink,
            subnetwork: subnet.selfLink,
            backendService: backend.selfLink,
            description: "intercept deployment rule",
          });
          const group = yield* GCP.NetworkSecurity.InterceptDeploymentGroup(
            "Inspect",
            {
              location: "global",
              network: vpc.selfLink.as<string>(),
              description: "intercept deployment group",
              labels: { env: "test" },
            },
          );
          const deployment = yield* GCP.NetworkSecurity.InterceptDeployment(
            "ZoneA",
            {
              location: "us-central1-a",
              interceptDeploymentGroup: group.name,
              forwardingRule: rule.selfLink.as<string>(),
              description: "intercept deployment a",
              labels: { env: "test" },
            },
          );
          return { vpc, subnet, healthCheck, backend, rule, group, deployment };
        }),
      );

      expect(created.deployment.name).toContain("/interceptDeployments/");
      expect(created.deployment.location).toEqual("us-central1-a");
      expect(created.deployment.description).toEqual("intercept deployment a");
      expect(created.deployment.labels).toMatchObject({ env: "test" });
      expect(created.deployment.interceptDeploymentGroup).toEqual(
        created.group.name,
      );

      const fetched =
        yield* networksecurity.getProjectsLocationsInterceptDeployments({
          name: created.deployment.name,
        });
      expect(fetched.name).toEqual(created.deployment.name);
      expect(fetched.description).toEqual("intercept deployment a");
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
            description: "intercept deployment vpc",
          });
          const subnet = yield* GCP.Compute.Subnetwork("Subnet", {
            subnetworkName: created.subnet.subnetworkName,
            region: "us-central1",
            network: vpc.networkName,
            ipCidrRange: "10.90.0.0/24",
            description: "intercept deployment subnet",
          });
          const healthCheck = yield* GCP.Compute.RegionHealthCheck("Hc", {
            healthCheckName: created.healthCheck.healthCheckName,
            region: "us-central1",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
            description: "intercept deployment hc",
          });
          const backend = yield* GCP.Compute.RegionBackendService("Backend", {
            name: created.backend.name,
            region: "us-central1",
            protocol: "UDP",
            loadBalancingScheme: "INTERNAL",
            network: vpc.selfLink,
            healthChecks: [healthCheck.selfLink.as<string>()],
            description: "intercept deployment backend",
          });
          const rule = yield* GCP.Compute.ForwardingRule("Rule", {
            forwardingRuleName: created.rule.forwardingRuleName,
            region: "us-central1",
            loadBalancingScheme: "INTERNAL",
            ipProtocol: "UDP",
            ports: ["6081"],
            network: vpc.selfLink,
            subnetwork: subnet.selfLink,
            backendService: backend.selfLink,
            description: "intercept deployment rule",
          });
          const group = yield* GCP.NetworkSecurity.InterceptDeploymentGroup(
            "Inspect",
            {
              interceptDeploymentGroupId:
                created.group.interceptDeploymentGroupId,
              location: "global",
              network: vpc.selfLink.as<string>(),
              description: "intercept deployment group",
              labels: { env: "test" },
            },
          );
          const deployment = yield* GCP.NetworkSecurity.InterceptDeployment(
            "ZoneA",
            {
              interceptDeploymentId: created.deployment.interceptDeploymentId,
              location: "us-central1-a",
              interceptDeploymentGroup: group.name,
              forwardingRule: rule.selfLink.as<string>(),
              description: "intercept deployment b",
              labels: { env: "prod", role: "intercept" },
            },
          );
          return { vpc, subnet, healthCheck, backend, rule, group, deployment };
        }),
      );

      expect(updated.deployment.name).toEqual(created.deployment.name);
      expect(updated.deployment.description).toEqual("intercept deployment b");
      expect(updated.deployment.labels).toMatchObject({
        env: "prod",
        role: "intercept",
      });

      const refetched =
        yield* networksecurity.getProjectsLocationsInterceptDeployments({
          name: created.deployment.name,
        });
      expect(refetched.description).toEqual("intercept deployment b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("intercept");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.deployment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 600_000,
  },
);
