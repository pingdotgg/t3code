import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Describe-level coverage for the Phase-2 config sugar that doesn't need a
// running task: `serviceRegistry` (composed Cloud Map service wired into
// `serviceRegistries`), the `{ efs, path }` volume sugar, and the
// container-level `healthCheck`. `desiredCount: 0` keeps it fast — the task
// definition and service wiring are fully observable without placement.
//
// Requires a local Docker daemon (the `image:` source mirrors into ECR).
test.provider.skipIf(!!process.env.FAST)(
  "serviceRegistry, EFS volume sugar, and container healthCheck land on the service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getDefaultVpcNetwork;

      const azSubnets = yield* ec2
        .describeSubnets({
          Filters: [
            { Name: "vpc-id", Values: [net.vpcId] },
            { Name: "default-for-az", Values: ["true"] },
          ],
        })
        .pipe(
          Effect.map((r) =>
            (r.Subnets ?? []).flatMap((s) => (s.SubnetId ? [s.SubnetId] : [])),
          ),
        );

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("ConfigCluster", {
            clusterName: "alchemy-test-ecs-phase2-config",
          });
          const namespace = yield* AWS.CloudMap.PrivateDnsNamespace(
            "ConfigNamespace",
            {
              name: "phase2-config.alchemy-test.internal",
              vpc: net.vpcId,
            },
          );
          const fileSystem = yield* AWS.EFS.FileSystem("ConfigFs", {});
          const service = yield* Service("ConfigSvc", {
            cluster,
            image: "busybox:stable",
            command: ["sh", "-c", "while true; do sleep 30; done"],
            port: 8080,
            desiredCount: 0,
            vpcId: net.vpcId as string,
            subnets: azSubnets,
            serviceRegistry: { namespace },
            volumes: [{ efs: fileSystem, path: "/mnt/data" }],
            healthCheck: {
              command: ["CMD-SHELL", "exit 0"],
              interval: "30 seconds",
              timeout: "5 seconds",
              retries: 3,
              startPeriod: "10 seconds",
            },
          });
          return {
            serviceName: service.serviceName.as<string>(),
            clusterArn: service.clusterArn.as<string>(),
            taskDefinitionArn: service.taskDefinitionArn.as<string>(),
            fileSystemId: fileSystem.fileSystemId.as<string>(),
            namespaceId: namespace.namespaceId.as<string>(),
          };
        }),
      );

      // ── serviceRegistry: the composed Cloud Map service is wired in ───
      const services = yield* ecs.describeServices({
        cluster: deployed.clusterArn,
        services: [deployed.serviceName],
      });
      const registryArn =
        services.services?.[0]?.serviceRegistries?.[0]?.registryArn;
      expect(registryArn).toContain(":servicediscovery:");
      const cloudMapServiceId = registryArn!.split("/").pop()!;
      const cloudMapService = yield* sd.getService({ Id: cloudMapServiceId });
      expect(cloudMapService.Service?.NamespaceId).toBe(deployed.namespaceId);
      expect(
        cloudMapService.Service?.DnsConfig?.DnsRecords?.map((r) => r.Type),
      ).toEqual(["A"]);

      // ── volumes + healthCheck sugar on the task definition ────────────
      const described = yield* ecs.describeTaskDefinition({
        taskDefinition: deployed.taskDefinitionArn,
      });
      const volume = described.taskDefinition?.volumes?.[0];
      expect(volume?.name).toBe("efs-0");
      expect(volume?.efsVolumeConfiguration?.fileSystemId).toBe(
        deployed.fileSystemId,
      );
      expect(volume?.efsVolumeConfiguration?.transitEncryption).toBe("ENABLED");
      const container = described.taskDefinition?.containerDefinitions?.[0];
      const mountPoint = container?.mountPoints?.[0];
      expect(container?.mountPoints?.length).toBe(1);
      expect(mountPoint?.sourceVolume).toBe("efs-0");
      expect(mountPoint?.containerPath).toBe("/mnt/data");
      expect(container?.healthCheck?.command).toEqual(["CMD-SHELL", "exit 0"]);
      expect(container?.healthCheck?.interval).toBe(30);
      expect(container?.healthCheck?.timeout).toBe(5);
      expect(container?.healthCheck?.retries).toBe(3);
      expect(container?.healthCheck?.startPeriod).toBe(10);

      // ── destroy + zero-orphan proofs ──────────────────────────────────
      yield* stack.destroy();

      const cloudMapGone = yield* sd.getService({ Id: cloudMapServiceId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ServiceNotFound", () => Effect.succeed(true)),
      );
      expect(cloudMapGone).toBe(true);

      const namespaceGone = yield* sd
        .getNamespace({ Id: deployed.namespaceId })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
        );
      expect(namespaceGone).toBe(true);
    }),
  { timeout: 600_000 },
);
