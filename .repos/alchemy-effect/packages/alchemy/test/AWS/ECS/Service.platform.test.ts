import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// The default VPC's per-AZ default subnets (exactly one per AZ). Concurrent
// suite runs create EXTRA subnets in the default VPC, and an ALB rejects two
// subnets in the same AZ — so never use the full subnet list for ALBs.
const defaultAzSubnets = (vpcId: string) =>
  ec2
    .describeSubnets({
      Filters: [
        { Name: "vpc-id", Values: [vpcId] },
        { Name: "default-for-az", Values: ["true"] },
      ],
    })
    .pipe(
      Effect.map((r) =>
        (r.Subnets ?? []).flatMap((s) => (s.SubnetId ? [s.SubnetId] : [])),
      ),
    );

// The image-owning `Service` platform form: `image:` (mirrored into ECR) with
// `loadBalancer: true` — the Service synthesizes its own task definition
// (roles, log group, ECR repository) and wires an ALB + target group +
// listener + owned ingress security group, defaulting networking to the
// account's default VPC. `desiredCount: 0` keeps the test inside the speed
// budget (no Fargate placement, no image pull on the service side — the
// mirror is a local docker pull/tag/push of a tiny busybox).
//
// Requires a local Docker daemon (same as the ECS Bindings fixture).
test.provider(
  "image-owning service synthesizes its task definition and ALB",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("PlatformSvcCluster", {
            clusterName: "alchemy-test-ecs-service-platform",
          });
          // Docker Hub busybox: the public.ecr.aws mirror aggressively
          // rate-limits anonymous pulls during local builds.
          return yield* Service("PlatformEdge", {
            cluster,
            image: "busybox:stable",
            command: ["sh", "-c", "while true; do sleep 30; done"],
            port: 80,
            desiredCount: 0,
            loadBalancer: true,
          });
        }),
      );

      // Synthesized task definition attributes.
      expect(deployed.serviceArn).toBeTruthy();
      expect(deployed.taskDefinitionArn).toBeTruthy();
      expect(deployed.taskFamily).toBeTruthy();
      expect(deployed.repositoryName).toBeTruthy();
      expect(deployed.imageUri).toContain(deployed.repositoryName!);
      expect(deployed.code?.hash).toBeTruthy();
      expect(deployed.taskRoleArn).toBeTruthy();
      expect(deployed.executionRoleArn).toBeTruthy();
      expect(deployed.logGroupName).toBeTruthy();

      // Managed ingress attributes.
      expect(deployed.url).toMatch(/^http:\/\//);
      expect(deployed.loadBalancerArn).toBeTruthy();
      expect(deployed.targetGroupArn).toBeTruthy();
      expect(deployed.listenerArn).toBeTruthy();
      expect(deployed.securityGroupId).toBeTruthy();

      // Out-of-band: the registered task definition runs the mirrored image.
      const described = yield* ecs.describeTaskDefinition({
        taskDefinition: deployed.taskDefinitionArn,
      });
      const container = described.taskDefinition?.containerDefinitions?.[0];
      expect(container?.image).toBe(deployed.imageUri);
      expect(container?.command).toEqual([
        "sh",
        "-c",
        "while true; do sleep 30; done",
      ]);
      expect(container?.portMappings?.[0]?.containerPort).toBe(80);

      // Out-of-band: the service is wired to the generated target group.
      const services = yield* ecs.describeServices({
        cluster: deployed.clusterArn,
        services: [deployed.serviceName],
      });
      const svc = services.services?.[0];
      expect(svc?.loadBalancers?.[0]?.targetGroupArn).toBe(
        deployed.targetGroupArn,
      );
      expect(svc?.loadBalancers?.[0]?.containerPort).toBe(80);

      yield* stack.destroy();

      // Zero-orphan proofs: every owned resource is gone (or terminally
      // deleting) after destroy.
      const repoGone = yield* ecr
        .describeRepositories({
          repositoryNames: [deployed.repositoryName!],
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("RepositoryNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(repoGone).toBe(true);

      const lbGone = yield* elbv2
        .describeLoadBalancers({
          LoadBalancerArns: [deployed.loadBalancerArn!],
        })
        .pipe(
          Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(lbGone).toBe(true);

      const sgGone = yield* ec2
        .describeSecurityGroups({ GroupIds: [deployed.securityGroupId!] })
        .pipe(
          Effect.map((r) => (r.SecurityGroups ?? []).length === 0),
          Effect.catchTag("InvalidGroup.NotFound", () => Effect.succeed(true)),
        );
      expect(sgGone).toBe(true);

      // The revision is deregistered (INACTIVE / DELETE_IN_PROGRESS) or
      // already hard-deleted.
      const taskDefGone = yield* ecs
        .describeTaskDefinition({
          taskDefinition: deployed.taskDefinitionArn,
        })
        .pipe(
          Effect.map((r) => r.taskDefinition?.status !== "ACTIVE"),
          Effect.catchTag("ClientException", () => Effect.succeed(true)),
        );
      expect(taskDefGone).toBe(true);

      const clusters = yield* ecs.describeClusters({
        clusters: ["alchemy-test-ecs-service-platform"],
      });
      expect((clusters.clusters ?? []).some((c) => c.status === "ACTIVE")).toBe(
        false,
      );
    }),
  { timeout: 420_000 },
);

// Migration reap: state rows written by the pre-composition provider carry
// the inline-created ALB/TG/listener/SG ARNs in the service's own attributes
// with no `ingressKind` marker. The first reconcile under the composed shape
// must DELETE that legacy inline infrastructure (nothing stranded) and stamp
// the composed attrs. We simulate the legacy row exactly the way the #736
// test simulates a wedged one: deploy under the new shape, create a real
// "legacy" ALB/TG/listener/SG out of band, then rewrite the service's state
// row to reference them (marker stripped, `ingress` prop removed,
// `loadBalancer: true`), and redeploy.
test.provider(
  "legacy inline ingress is reaped on first reconcile under the composed shape",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getDefaultVpcNetwork;

      const program = Effect.gen(function* () {
        const cluster = yield* Cluster("LegacyReapCluster", {
          clusterName: "alchemy-test-ecs-service-legacy-reap",
        });
        return yield* Service("LegacyReapEdge", {
          cluster,
          image: "busybox:stable",
          command: ["sh", "-c", "while true; do sleep 30; done"],
          port: 80,
          desiredCount: 0,
          loadBalancer: true,
        });
      });

      const deployed = yield* stack.deploy(program);
      expect(deployed.loadBalancerArn).toBeTruthy();

      // Out-of-band "legacy" inline ingress (never carried any traffic, so
      // reap deletes are instant). Finalizers reclaim them if the test dies
      // before the reap runs.
      const legacyName = "alchemy-test-ecs-svc-legacy";
      const legacySubnets = yield* defaultAzSubnets(net.vpcId);
      const legacyLb = yield* elbv2.createLoadBalancer({
        Name: legacyName,
        Type: "application",
        Scheme: "internal",
        Subnets: legacySubnets,
      });
      const legacyLbArn = legacyLb.LoadBalancers?.[0]?.LoadBalancerArn!;
      yield* Effect.addFinalizer(() =>
        elbv2
          .deleteLoadBalancer({ LoadBalancerArn: legacyLbArn })
          .pipe(Effect.ignore),
      );
      const legacyTg = yield* elbv2.createTargetGroup({
        Name: legacyName,
        VpcId: net.vpcId,
        TargetType: "ip",
        Protocol: "HTTP",
        Port: 80,
      });
      const legacyTgArn = legacyTg.TargetGroups?.[0]?.TargetGroupArn!;
      yield* Effect.addFinalizer(() =>
        elbv2
          .deleteTargetGroup({ TargetGroupArn: legacyTgArn })
          .pipe(Effect.ignore),
      );
      const legacyListener = yield* elbv2.createListener({
        LoadBalancerArn: legacyLbArn,
        Port: 80,
        Protocol: "HTTP",
        DefaultActions: [{ Type: "forward", TargetGroupArn: legacyTgArn }],
      });
      const legacyListenerArn = legacyListener.Listeners?.[0]?.ListenerArn!;
      yield* Effect.addFinalizer(() =>
        elbv2
          .deleteListener({ ListenerArn: legacyListenerArn })
          .pipe(Effect.ignore),
      );
      const legacySg = yield* ec2.createSecurityGroup({
        GroupName: legacyName,
        Description: "legacy inline ingress SG (reap test)",
        VpcId: net.vpcId,
      });
      const legacySgId = legacySg.GroupId!;
      yield* Effect.addFinalizer(() =>
        ec2.deleteSecurityGroup({ GroupId: legacySgId }).pipe(Effect.ignore),
      );

      // Rewrite the service's state row into the legacy inline shape.
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const serviceRow = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) && r.row.resourceType === "AWS.ECS.Service",
      );
      if (!serviceRow) {
        return yield* Effect.die(
          new Error("no AWS.ECS.Service state row found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: serviceRow.fqn,
        value: {
          ...serviceRow.row,
          attr: {
            ...(serviceRow.row.attr as object),
            // Legacy rows have the inline ARNs and NO ingressKind marker.
            ingressKind: undefined,
            loadBalancerArn: legacyLbArn,
            targetGroupArn: legacyTgArn,
            listenerArn: legacyListenerArn,
            securityGroupId: legacySgId,
            url: "http://legacy.invalid",
          },
          props: {
            ...serviceRow.row.props,
            ingress: undefined,
            loadBalancer: true,
          },
        },
      });

      // Redeploy: reconcile must reap the legacy inline infra and stamp the
      // composed attrs.
      const redeployed = yield* stack.deploy(program);
      expect(redeployed.ingressKind).toBe("owned");
      expect(redeployed.loadBalancerArn).toBeTruthy();
      expect(redeployed.loadBalancerArn).not.toBe(legacyLbArn);
      expect(redeployed.targetGroupArn).not.toBe(legacyTgArn);

      // The redeploy registered a NEW task-definition revision — the
      // superseded one must be reaped (deregistered + deleted), not left
      // ACTIVE forever. This is the exact leak this test used to produce:
      // one stranded ACTIVE revision per run.
      expect(redeployed.taskDefinitionArn).not.toBe(deployed.taskDefinitionArn);
      const supersededReaped = yield* ecs
        .describeTaskDefinition({
          taskDefinition: deployed.taskDefinitionArn,
        })
        .pipe(
          Effect.map((r) => r.taskDefinition?.status !== "ACTIVE"),
          Effect.catchTag("ClientException", () => Effect.succeed(true)),
        );
      expect(supersededReaped).toBe(true);

      // The legacy inline resources are gone (nothing stranded). The ALB
      // deletion is async — poll bounded.
      const legacyLbGone = yield* elbv2
        .describeLoadBalancers({ LoadBalancerArns: [legacyLbArn] })
        .pipe(
          Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(true),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (gone) => gone,
            times: 12,
          }),
        );
      expect(legacyLbGone).toBe(true);
      const legacyTgGone = yield* elbv2
        .describeTargetGroups({ TargetGroupArns: [legacyTgArn] })
        .pipe(
          Effect.map((r) => (r.TargetGroups ?? []).length === 0),
          Effect.catchTag("TargetGroupNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(legacyTgGone).toBe(true);
      const legacySgGone = yield* ec2
        .describeSecurityGroups({ GroupIds: [legacySgId] })
        .pipe(
          Effect.map((r) => (r.SecurityGroups ?? []).length === 0),
          Effect.catchTag("InvalidGroup.NotFound", () => Effect.succeed(true)),
        );
      expect(legacySgGone).toBe(true);

      yield* stack.destroy();

      // The composed ingress is gone after destroy too.
      const composedLbGone = yield* elbv2
        .describeLoadBalancers({
          LoadBalancerArns: [redeployed.loadBalancerArn!],
        })
        .pipe(
          Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(composedLbGone).toBe(true);

      // Zero-orphan proof for the synthesized task definition: NO revision
      // of the family survives destroy as ACTIVE (deploy + redeploy
      // registered two revisions; both must be gone).
      const activeRevisions = yield* ecs
        .listTaskDefinitions({
          familyPrefix: redeployed.taskFamily!,
          status: "ACTIVE",
        })
        .pipe(
          Effect.map((r) =>
            (r.taskDefinitionArns ?? []).filter((arn) =>
              arn.includes(`/${redeployed.taskFamily!}:`),
            ),
          ),
          Effect.catchTag("ClientException", () =>
            Effect.succeed([] as string[]),
          ),
        );
      expect(activeRevisions).toEqual([]);
    }),
  { timeout: 420_000 },
);
