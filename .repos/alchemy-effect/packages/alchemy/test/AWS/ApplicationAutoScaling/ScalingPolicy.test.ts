import * as AWS from "@/AWS";
import { ScalableTarget, ScalingPolicy } from "@/AWS/ApplicationAutoScaling";
import { Table } from "@/AWS/DynamoDB";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const describePolicy = (policyName: string) =>
  aas
    .describeScalingPolicies({
      ServiceNamespace: "dynamodb",
      PolicyNames: [policyName],
    })
    .pipe(
      Effect.map((res) =>
        res.ScalingPolicies?.find((p) => p.PolicyName === policyName),
      ),
    );

const waitUntilPolicyGone = (policyName: string) =>
  describePolicy(policyName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (policy) => policy === undefined,
      times: 10,
    }),
  );

// Target-tracking lifecycle against a provisioned DynamoDB table: put a
// DynamoDBReadCapacityUtilization tracking policy on a fresh scalable target
// (exercising the target-propagation retry), verify the managed CloudWatch
// alarms out-of-band, update the target value in place (same policy ARN),
// then destroy and verify deletion.
test.provider(
  "target tracking policy lifecycle (dynamodb)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (targetValue: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const table = yield* Table("AasPolicyTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              billingMode: "PROVISIONED",
              provisionedThroughput: {
                ReadCapacityUnits: 1,
                WriteCapacityUnits: 1,
              },
            });
            const target = yield* ScalableTarget("AasPolicyTarget", {
              serviceNamespace: "dynamodb",
              resourceId: Output.interpolate`table/${table.tableName}`,
              scalableDimension: "dynamodb:table:ReadCapacityUnits",
              minCapacity: 1,
              maxCapacity: 5,
            });
            const policy = yield* ScalingPolicy("AasTrackingPolicy", {
              serviceNamespace: target.serviceNamespace,
              resourceId: target.resourceId,
              scalableDimension: target.scalableDimension,
              targetTracking: {
                TargetValue: targetValue,
                PredefinedMetricSpecification: {
                  PredefinedMetricType: "DynamoDBReadCapacityUtilization",
                },
                ScaleOutCooldown: 60,
                ScaleInCooldown: 60,
              },
            });
            return {
              resourceId: target.resourceId.as<string>(),
              policyName: policy.policyName.as<string>(),
              policyArn: policy.policyArn.as<string>(),
              policyType: policy.policyType.as<string>(),
            };
          }),
        );

      const created = yield* deploy(70);
      expect(created.policyType).toBe("TargetTrackingScaling");
      expect(created.policyArn).toContain("scalingPolicy");

      // Out-of-band: the policy tracks the requested value and Application
      // Auto Scaling created its managed CloudWatch alarms.
      const observed = yield* describePolicy(created.policyName);
      expect(observed?.PolicyType).toBe("TargetTrackingScaling");
      expect(
        observed?.TargetTrackingScalingPolicyConfiguration?.TargetValue,
      ).toBe(70);
      expect((observed?.Alarms ?? []).length).toBeGreaterThan(0);

      // Update in place — same name and ARN, new target value.
      const updated = yield* deploy(60);
      expect(updated.policyArn).toEqual(created.policyArn);
      const observedAfterUpdate = yield* describePolicy(created.policyName);
      expect(
        observedAfterUpdate?.TargetTrackingScalingPolicyConfiguration
          ?.TargetValue,
      ).toBe(60);

      yield* stack.destroy();
      const gone = yield* waitUntilPolicyGone(created.policyName);
      expect(gone).toBeUndefined();

      // The target is deregistered too.
      const targets = yield* aas.describeScalableTargets({
        ServiceNamespace: "dynamodb",
        ResourceIds: [created.resourceId],
        ScalableDimension: "dynamodb:table:ReadCapacityUnits",
      });
      expect(targets.ScalableTargets ?? []).toHaveLength(0);
    }),
  { timeout: 240_000 },
);

// Deregistering a scalable target implicitly deletes its policies. Simulate
// an out-of-band deregistration and assert destroy still converges: the
// policy delete observes the typed ObjectNotFoundException and succeeds.
test.provider(
  "destroy tolerates a target deregistered out-of-band (implicit policy deletion)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const table = yield* Table("AasDeregTable", {
            partitionKey: "id",
            attributes: { id: "S" },
            billingMode: "PROVISIONED",
            provisionedThroughput: {
              ReadCapacityUnits: 1,
              WriteCapacityUnits: 1,
            },
          });
          const target = yield* ScalableTarget("AasDeregTarget", {
            serviceNamespace: "dynamodb",
            resourceId: Output.interpolate`table/${table.tableName}`,
            scalableDimension: "dynamodb:table:ReadCapacityUnits",
            minCapacity: 1,
            maxCapacity: 3,
          });
          // NOTE: DynamoDB targets only support TargetTrackingScaling —
          // putScalingPolicy with StepScaling is rejected (step-scaling
          // coverage lives in EcsServiceScaling.test.ts).
          const policy = yield* ScalingPolicy("AasDeregPolicy", {
            serviceNamespace: target.serviceNamespace,
            resourceId: target.resourceId,
            scalableDimension: target.scalableDimension,
            targetTracking: {
              TargetValue: 70,
              PredefinedMetricSpecification: {
                PredefinedMetricType: "DynamoDBReadCapacityUtilization",
              },
            },
          });
          return {
            resourceId: target.resourceId.as<string>(),
            policyName: policy.policyName.as<string>(),
            policyType: policy.policyType.as<string>(),
          };
        }),
      );
      expect(created.policyType).toBe("TargetTrackingScaling");

      // Deregister the target out-of-band — AWS implicitly deletes the
      // attached scaling policy.
      yield* aas.deregisterScalableTarget({
        ServiceNamespace: "dynamodb",
        ResourceId: created.resourceId,
        ScalableDimension: "dynamodb:table:ReadCapacityUnits",
      });
      const gone = yield* waitUntilPolicyGone(created.policyName);
      expect(gone).toBeUndefined();

      // Destroy must still converge: deleteScalingPolicy and
      // deregisterScalableTarget both hit ObjectNotFoundException and treat
      // it as success.
      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({
    stack: stk.name,
    stage: stk.stage,
    fqn,
  })) as ResourceState | undefined;
});

const setState = Effect.fn(function* (fqn: string, value: ResourceState) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
});

// An apply interrupted mid-create (Ctrl-C, crash, CI timeout) can persist a
// policy row WITHOUT its target triple — `scalableDimension` set,
// `resourceId` missing. Application Auto Scaling treats ResourceId and
// ScalableDimension as a pair: one without the other is
// "ValidationException: Scalable dimension cannot be provided without a
// resource ID", which used to fail `read` (so every plan) and `delete` (so
// every destroy of the stack — and every resource depending on the policy
// was skipped with it). The provider must converge from that row: a
// re-deploy observes the live policy by name and restores the triple, and a
// destroy deletes it with the triple the live policy reports.
test.provider(
  "read and destroy converge from a row persisted by an interrupted create",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const table = yield* Table("AasPartialTable", {
          partitionKey: "id",
          attributes: { id: "S" },
          billingMode: "PROVISIONED",
          provisionedThroughput: {
            ReadCapacityUnits: 1,
            WriteCapacityUnits: 1,
          },
        });
        const target = yield* ScalableTarget("AasPartialTarget", {
          serviceNamespace: "dynamodb",
          resourceId: Output.interpolate`table/${table.tableName}`,
          scalableDimension: "dynamodb:table:ReadCapacityUnits",
          minCapacity: 1,
          maxCapacity: 3,
        });
        const policy = yield* ScalingPolicy("AasPartialPolicy", {
          serviceNamespace: target.serviceNamespace,
          resourceId: target.resourceId,
          scalableDimension: target.scalableDimension,
          targetTracking: {
            TargetValue: 70,
            PredefinedMetricSpecification: {
              PredefinedMetricType: "DynamoDBReadCapacityUtilization",
            },
          },
        });
        return {
          resourceId: target.resourceId.as<string>(),
          policyName: policy.policyName.as<string>(),
          policyResourceId: policy.resourceId.as<string>(),
        };
      });

      const created = yield* stack.deploy(program);
      expect(created.policyResourceId).toBe(created.resourceId);

      // Simulate the interrupted create: the persisted attrs lose their
      // resourceId but keep the scalable dimension.
      const row = yield* getState("AasPartialPolicy");
      expect(row?.status).toBe("created");
      if (row?.status !== "created") return;
      const attr = row.attr as { resourceId?: string; [key: string]: unknown };
      expect(attr.resourceId).toBe(created.resourceId);
      const { resourceId: _dropped, ...partialAttr } = attr;
      const partialRow: ResourceState = { ...row, attr: partialAttr };
      const readResourceId = Effect.map(
        getState("AasPartialPolicy"),
        (r) => (r?.status === "created" ? r.attr : undefined)?.resourceId,
      );
      yield* setState("AasPartialPolicy", partialRow);
      expect(yield* readResourceId).toBe(undefined);

      // `read` (refresh/sync/adopt) must observe the live policy by name
      // and report the full triple rather than fail on the partial row —
      // including when the Output-valued `resourceId` prop was lost too.
      const provider = yield* Provider.findProvider(ScalingPolicy);
      const { resourceId: _droppedProp, ...partialProps } =
        partialRow.props as { resourceId?: string; [key: string]: unknown };
      const observed = yield* provider.read!({
        id: "AasPartialPolicy",
        fqn: partialRow.fqn,
        instanceId: partialRow.instanceId,
        olds: partialProps as unknown as ScalingPolicy["Props"],
        output: partialAttr as ScalingPolicy["Attributes"],
      });
      expect(observed?.resourceId).toBe(created.resourceId);
      expect(observed?.scalableDimension).toBe(
        "dynamodb:table:ReadCapacityUnits",
      );

      // And `delete` (every destroy) must converge from the partial row
      // instead of wedging the stack.
      yield* stack.destroy();
      const gone = yield* waitUntilPolicyGone(created.policyName);
      expect(gone).toBeUndefined();
    }),
  { timeout: 240_000 },
);
