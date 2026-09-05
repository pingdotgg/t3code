import * as AWS from "@/AWS";
import { ScalableTarget, ScalingPolicy } from "@/AWS/ApplicationAutoScaling";
import { Subnet } from "@/AWS/EC2/Subnet.ts";
import { Vpc } from "@/AWS/EC2/Vpc.ts";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { reclaimTaskDefinitionFamily } from "../ECS/reclaimTaskDefinitionFamily.ts";

const { test } = Test.make({ providers: AWS.providers() });

const clusterName = "alchemy-test-aas-ecs";

// The flagship ECS-service scaling flow: register the service's DesiredCount
// dimension (min 1 / max 3), attach a CPU target-tracking policy, verify both
// out-of-band, update the policy target in place, and destroy in dependency
// order (policy -> target -> service -> cluster -> networking).
//
// To stay inside the speed budget we avoid building/pushing a Docker image
// and register a minimal task definition against a public image out of band
// (the same pattern as test/AWS/ECS/Service.test.ts). `createService` returns
// without waiting for Fargate placement, so the suite never blocks on task
// startup; the scalable target and policy only require the service to exist.
test.provider(
  "ecs service DesiredCount target + CPU target tracking policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Pre-clean: reclaim revisions a previously killed run may have left,
      // then register this run's revision.
      yield* reclaimTaskDefinitionFamily(clusterName);

      const registered = yield* ecs.registerTaskDefinition({
        family: "alchemy-test-aas-ecs",
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: "app",
            image: "public.ecr.aws/nginx/nginx:stable",
            essential: true,
            portMappings: [{ containerPort: 80, protocol: "tcp" }],
          },
        ],
      });
      const taskDefinitionArn = registered.taskDefinition?.taskDefinitionArn!;
      // Safety net: fully reclaim the out-of-band family on scope close even
      // if the body fails — deregister + hard-delete so no INACTIVE revision
      // survives the run.
      yield* Effect.addFinalizer(() =>
        reclaimTaskDefinitionFamily(clusterName).pipe(Effect.ignore),
      );

      const deploy = (targetValue: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("AasEcsVpc", { cidrBlock: "10.76.0.0/16" });
            const subnet = yield* Subnet("AasEcsSubnet", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.76.1.0/24",
            });
            const cluster = yield* Cluster("AasEcsCluster", { clusterName });
            const service = yield* Service("AasEcsService", {
              cluster,
              task: { taskDefinitionArn, containerName: "app", port: 80 },
              desiredCount: 1,
              vpcId: vpc.vpcId,
              subnets: [subnet.subnetId],
            });
            const target = yield* ScalableTarget("AasEcsTarget", {
              serviceNamespace: "ecs",
              resourceId: Output.interpolate`service/${clusterName}/${service.serviceName}`,
              scalableDimension: "ecs:service:DesiredCount",
              minCapacity: 1,
              maxCapacity: 3,
            });
            const policy = yield* ScalingPolicy("AasEcsCpuPolicy", {
              serviceNamespace: target.serviceNamespace,
              resourceId: target.resourceId,
              scalableDimension: target.scalableDimension,
              targetTracking: {
                TargetValue: targetValue,
                PredefinedMetricSpecification: {
                  PredefinedMetricType: "ECSServiceAverageCPUUtilization",
                },
                ScaleOutCooldown: 60,
                ScaleInCooldown: 60,
              },
            });
            // ECS also supports StepScaling — cover that policy branch here
            // (DynamoDB targets reject it, so the DynamoDB suites cannot).
            const stepPolicy = yield* ScalingPolicy("AasEcsStepPolicy", {
              serviceNamespace: target.serviceNamespace,
              resourceId: target.resourceId,
              scalableDimension: target.scalableDimension,
              stepScaling: {
                AdjustmentType: "ChangeInCapacity",
                Cooldown: 60,
                MetricAggregationType: "Average",
                StepAdjustments: [
                  { MetricIntervalLowerBound: 0, ScalingAdjustment: 1 },
                ],
              },
            });
            return {
              serviceName: service.serviceName.as<string>(),
              resourceId: target.resourceId.as<string>(),
              scalableTargetArn: target.scalableTargetArn.as<string>(),
              policyName: policy.policyName.as<string>(),
              policyArn: policy.policyArn.as<string>(),
              stepPolicyName: stepPolicy.policyName.as<string>(),
              stepPolicyType: stepPolicy.policyType.as<string>(),
            };
          }),
        );

      const created = yield* deploy(50);
      expect(created.resourceId).toEqual(
        `service/${clusterName}/${created.serviceName}`,
      );
      expect(created.scalableTargetArn).toContain("scalable-target/");

      // Out-of-band: the DesiredCount dimension is registered min 1 / max 3.
      const targets = yield* aas.describeScalableTargets({
        ServiceNamespace: "ecs",
        ResourceIds: [created.resourceId],
        ScalableDimension: "ecs:service:DesiredCount",
      });
      const observedTarget = targets.ScalableTargets?.[0];
      expect(observedTarget?.MinCapacity).toBe(1);
      expect(observedTarget?.MaxCapacity).toBe(3);

      // Out-of-band: the tracking policy exists with its managed alarms.
      const policies = yield* aas.describeScalingPolicies({
        ServiceNamespace: "ecs",
        PolicyNames: [created.policyName],
        ResourceId: created.resourceId,
      });
      const observedPolicy = policies.ScalingPolicies?.[0];
      expect(observedPolicy?.PolicyType).toBe("TargetTrackingScaling");
      expect(
        observedPolicy?.TargetTrackingScalingPolicyConfiguration?.TargetValue,
      ).toBe(50);
      expect((observedPolicy?.Alarms ?? []).length).toBeGreaterThan(0);

      // Out-of-band: the step scaling policy exists with its adjustments.
      expect(created.stepPolicyType).toBe("StepScaling");
      const stepPolicies = yield* aas.describeScalingPolicies({
        ServiceNamespace: "ecs",
        PolicyNames: [created.stepPolicyName],
        ResourceId: created.resourceId,
      });
      const observedStepPolicy = stepPolicies.ScalingPolicies?.[0];
      expect(observedStepPolicy?.PolicyType).toBe("StepScaling");
      expect(
        observedStepPolicy?.StepScalingPolicyConfiguration?.StepAdjustments,
      ).toEqual([{ MetricIntervalLowerBound: 0, ScalingAdjustment: 1 }]);

      // Update the policy target in place — same policy ARN.
      const updated = yield* deploy(30);
      expect(updated.policyArn).toEqual(created.policyArn);
      const policiesAfterUpdate = yield* aas.describeScalingPolicies({
        ServiceNamespace: "ecs",
        PolicyNames: [created.policyName],
        ResourceId: created.resourceId,
      });
      expect(
        policiesAfterUpdate.ScalingPolicies?.[0]
          ?.TargetTrackingScalingPolicyConfiguration?.TargetValue,
      ).toBe(30);

      // Destroy in dependency order and verify deregistration out-of-band.
      yield* stack.destroy();
      const targetsAfterDestroy = yield* aas
        .describeScalableTargets({
          ServiceNamespace: "ecs",
          ResourceIds: [created.resourceId],
          ScalableDimension: "ecs:service:DesiredCount",
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (res) => (res.ScalableTargets ?? []).length === 0,
            times: 10,
          }),
        );
      expect(targetsAfterDestroy.ScalableTargets ?? []).toHaveLength(0);
      const policiesAfterDestroy = yield* aas.describeScalingPolicies({
        ServiceNamespace: "ecs",
        PolicyNames: [created.policyName],
        ResourceId: created.resourceId,
      });
      expect(policiesAfterDestroy.ScalingPolicies ?? []).toHaveLength(0);

      yield* reclaimTaskDefinitionFamily(clusterName);
    }),
  { timeout: 240_000 },
);
