import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import { TaskDefinition } from "@/AWS/ECS/TaskDefinition.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Latest ACTIVE revision of a family, or undefined when none exists
// (describeTaskDefinition by family rejects with ClientException once every
// revision is INACTIVE/deleted).
const describeActive = (family: string) =>
  ecs.describeTaskDefinition({ taskDefinition: family }).pipe(
    Effect.map((d) =>
      d.taskDefinition?.status === "ACTIVE" ? d.taskDefinition : undefined,
    ),
    Effect.catchTag("ClientException", () => Effect.succeed(undefined)),
  );

const listExactFamily = (family: string, status: "ACTIVE" | "INACTIVE") =>
  ecs
    .listTaskDefinitions({ familyPrefix: family, status })
    .pipe(
      Effect.map((result) =>
        (result.taskDefinitionArns ?? []).filter((arn) =>
          arn.includes(`/${family}:`),
        ),
      ),
    );

// Lifecycle: register -> no-op redeploy (same revision) -> content change
// (new revision, same family) -> destroy (all revisions deregistered, managed
// log group deleted).
test.provider("registers immutable revisions per content change", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const family = "alchemy-test-ecs-taskdef-life";

    const deployTaskDefinition = (env: string) =>
      stack.deploy(
        Effect.gen(function* () {
          // Fargate rejects the awslogs driver without an execution role —
          // also exercises passing an IAM Role resource as the role ref.
          const executionRole = yield* Role("LifecycleExecutionRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ecs-tasks.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
            ],
          });
          return yield* TaskDefinition("LifecycleTaskDef", {
            family,
            executionRoleArn: executionRole,
            containerDefinitions: [
              {
                name: "app",
                image: "public.ecr.aws/docker/library/busybox:stable",
                essential: true,
                command: ["sleep", "3600"],
                environment: [{ name: "FOO", value: env }],
                portMappings: [{ containerPort: 8080 }],
              },
            ],
            awslogs: true,
            tags: { env: "test" },
          });
        }),
      );

    // Create — registers the first revision for this run.
    const created = yield* deployTaskDefinition("one");
    expect(created.family).toBe(family);
    expect(created.containerName).toBe("app");
    expect(created.port).toBe(8080);
    expect(created.logGroupName).toBe(`/ecs/${family}`);

    // Out-of-band: revision is ACTIVE, awslogs config was injected, tags
    // (internal + user) landed on the revision.
    const observed = yield* ecs.describeTaskDefinition({
      taskDefinition: created.taskDefinitionArn,
      include: ["TAGS"],
    });
    expect(observed.taskDefinition?.status).toBe("ACTIVE");
    const container = observed.taskDefinition?.containerDefinitions?.[0];
    expect(container?.logConfiguration?.logDriver).toBe("awslogs");
    expect(container?.logConfiguration?.options?.["awslogs-group"]).toBe(
      `/ecs/${family}`,
    );
    const tagMap = Object.fromEntries(
      (observed.tags ?? []).map((t) => [t.key, t.value]),
    );
    expect(tagMap.env).toBe("test");
    expect(tagMap["alchemy::id"]).toBe("LifecycleTaskDef");

    // The managed log group exists.
    const groups = yield* logs.describeLogGroups({
      logGroupNamePrefix: `/ecs/${family}`,
    });
    expect(
      groups.logGroups?.some((g) => g.logGroupName === `/ecs/${family}`),
    ).toBe(true);

    // No-op redeploy — identical content must NOT register a new revision.
    const same = yield* deployTaskDefinition("one");
    expect(same.taskDefinitionArn).toBe(created.taskDefinitionArn);
    expect(same.revision).toBe(created.revision);

    // Content change — a new revision under the same family.
    const changed = yield* deployTaskDefinition("two");
    expect(changed.family).toBe(family);
    expect(changed.revision).toBeGreaterThan(created.revision);
    expect(changed.taskDefinitionArn).not.toBe(created.taskDefinitionArn);

    // Destroy — every ACTIVE revision of the family is deregistered and the
    // managed log group is deleted.
    yield* stack.destroy();

    const remaining = yield* describeActive(family);
    expect(remaining).toBeUndefined();
    expect(yield* listExactFamily(family, "ACTIVE")).toEqual([]);
    expect(yield* listExactFamily(family, "INACTIVE")).toEqual([]);

    const groupsAfter = yield* logs.describeLogGroups({
      logGroupNamePrefix: `/ecs/${family}`,
    });
    expect(
      groupsAfter.logGroups?.some((g) => g.logGroupName === `/ecs/${family}`),
    ).toBe(false);
  }),
);

// Family change replaces the resource: a fresh family is registered and the
// old family's revisions are deregistered by the replacement delete.
test.provider("replaces the resource when the family changes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const familyA = "alchemy-test-ecs-taskdef-repl-a";
    const familyB = "alchemy-test-ecs-taskdef-repl-b";

    const deployTaskDefinition = (family: string) =>
      stack.deploy(
        Effect.gen(function* () {
          return yield* TaskDefinition("ReplaceTaskDef", {
            family,
            containerDefinitions: [
              {
                name: "app",
                image: "public.ecr.aws/docker/library/busybox:stable",
                essential: true,
                command: ["sleep", "3600"],
              },
            ],
          });
        }),
      );

    const created = yield* deployTaskDefinition(familyA);
    expect(created.family).toBe(familyA);
    expect(yield* describeActive(familyA)).toBeDefined();

    const replaced = yield* deployTaskDefinition(familyB);
    expect(replaced.family).toBe(familyB);
    expect(replaced.taskDefinitionArn).not.toBe(created.taskDefinitionArn);
    expect(yield* describeActive(familyB)).toBeDefined();
    // Old family fully deregistered by the replacement delete.
    expect(yield* describeActive(familyA)).toBeUndefined();
    expect(yield* listExactFamily(familyA, "ACTIVE")).toEqual([]);
    expect(yield* listExactFamily(familyA, "INACTIVE")).toEqual([]);

    yield* stack.destroy();
    expect(yield* describeActive(familyB)).toBeUndefined();
    expect(yield* listExactFamily(familyB, "ACTIVE")).toEqual([]);
    expect(yield* listExactFamily(familyB, "INACTIVE")).toEqual([]);
  }),
);

// BYO container end-to-end: a public nginx image (no build step) registered
// via TaskDefinition, wired into Service by passing the RESOURCE itself as the
// `task` prop (its taskDefinitionArn/containerName/port attributes satisfy the
// structural contract), launched on Fargate in a public subnet with a public
// IP, and observed reaching runningCount >= 1.
test.provider(
  "service runs a BYO task definition on Fargate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* ec2.describeAvailabilityZones({});
      const az = (azResult.AvailabilityZones ?? []).find(
        (z) => z.State === "available",
      )?.ZoneName!;
      const defaultVpc = yield* getDefaultVpc;

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          // Reuse the default VPC's public routing. This is ECS coverage, so
          // allocating another VPC only makes the suite contend for EC2's
          // small regional VPC quota during high-concurrency sweeps.
          const subnet = yield* Subnet("ByoSubnet", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(239),
            availabilityZone: az,
            mapPublicIpOnLaunch: true,
          });

          // BYO execution role (tests the IAM Role resource ref on
          // executionRoleArn) — needed by the awslogs log driver.
          const executionRole = yield* Role("ByoExecutionRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ecs-tasks.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
            ],
          });

          const taskDefinition = yield* TaskDefinition("ByoNginx", {
            family: "alchemy-test-ecs-taskdef-byo",
            executionRoleArn: executionRole,
            awslogs: true,
            containerDefinitions: [
              {
                name: "nginx",
                image: "public.ecr.aws/nginx/nginx:stable",
                essential: true,
                portMappings: [{ containerPort: 80, protocol: "tcp" }],
              },
            ],
          });

          const cluster = yield* Cluster("ByoCluster", {
            clusterName: "alchemy-test-ecs-taskdef-byo",
          });

          const service = yield* Service("ByoService", {
            cluster,
            // Whole TaskDefinition resource as the `task` prop — the BYO
            // wiring under test.
            task: taskDefinition,
            desiredCount: 1,
            vpcId: defaultVpc.vpcId,
            subnets: [subnet.subnetId],
            assignPublicIp: true,
          });

          return {
            clusterArn: service.clusterArn.as<string>(),
            serviceName: service.serviceName.as<string>(),
            serviceTaskDefinitionArn: service.taskDefinitionArn.as<string>(),
            taskDefinitionArn: taskDefinition.taskDefinitionArn.as<string>(),
          };
        }),
      );

      // The service deploys exactly the BYO revision.
      expect(out.serviceTaskDefinitionArn).toBe(out.taskDefinitionArn);

      // The container actually starts: poll (bounded) until runningCount >= 1.
      const running = yield* ecs
        .describeServices({
          cluster: out.clusterArn,
          services: [out.serviceName],
        })
        .pipe(
          Effect.map((d) => d.services?.[0]?.runningCount ?? 0),
          Effect.repeat({
            schedule: Schedule.spaced("8 seconds"),
            until: (count) => count >= 1,
            times: 20,
          }),
        );
      expect(running).toBeGreaterThanOrEqual(1);

      yield* stack.destroy();

      // Out-of-band: the family has no ACTIVE revision left.
      expect(
        yield* describeActive("alchemy-test-ecs-taskdef-byo"),
      ).toBeUndefined();

      // And the cluster is gone too (deleted clusters report INACTIVE).
      const clustersAfter = yield* ecs.describeClusters({
        clusters: ["alchemy-test-ecs-taskdef-byo"],
      });
      expect(
        (clustersAfter.clusters ?? []).some((c) => c.status === "ACTIVE"),
      ).toBe(false);
    }),
  { timeout: 420_000 },
);
