import * as EMR from "@/AWS/EMR";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "slow-handler.ts");

export class EmrSlowTestFunction extends Lambda.Function<Lambda.Function>()(
  "EmrSlowTestFunction",
) {}

/**
 * Cluster-scoped binding fixture: deploys a real single-node Spark cluster
 * (~10-15 minutes to WAITING, billed per instance-hour — gated behind
 * AWS_TEST_SLOW) and a Lambda bound to it with the steps data plane, the
 * cluster-inspection reads, and the managed scaling policy ops.
 *
 * The cluster launches into an EMR-chosen subnet of the account's default
 * VPC (no explicit `ec2SubnetId`), keeps itself alive between steps, and
 * carries a 2-hour auto-termination policy as a cost safety net.
 */
export default EmrSlowTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // EMR service role (legacy managed policy — the v2 policy requires
    // tag-scoped resources).
    const serviceRole = yield* IAM.Role("EmrBindingsServiceRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: ["elasticmapreduce.amazonaws.com"] },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonElasticMapReduceRole",
      ],
    });
    // EC2 instance role + profile (the job-flow role).
    const ec2Role = yield* IAM.Role("EmrBindingsEc2Role", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: ["ec2.amazonaws.com"] },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonElasticMapReduceforEC2Role",
      ],
    });
    const instanceProfile = yield* IAM.InstanceProfile("EmrBindingsProfile", {
      roleName: ec2Role.roleName,
    });

    // Single-node (master-only) Spark cluster — the cheapest live cluster
    // that can still run steps.
    const cluster = yield* EMR.Cluster("BindingsCluster", {
      releaseLabel: "emr-7.5.0",
      applications: ["Spark"],
      serviceRole: serviceRole.roleName,
      jobFlowRole: instanceProfile.instanceProfileName,
      instances: {
        masterInstanceType: "m5.xlarge",
        coreInstanceCount: 0,
        keepJobFlowAliveWhenNoSteps: true,
      },
      autoTerminationPolicy: { idleTimeout: "2 hours" },
      tags: { fixture: "emr-bindings" },
    });

    const addSteps = yield* EMR.AddJobFlowSteps(cluster);
    const describeStep = yield* EMR.DescribeStep(cluster);
    const listSteps = yield* EMR.ListSteps(cluster);
    const cancelSteps = yield* EMR.CancelSteps(cluster);
    const listInstances = yield* EMR.ListInstances(cluster);
    const listInstanceGroups = yield* EMR.ListInstanceGroups(cluster);
    const listBootstrapActions = yield* EMR.ListBootstrapActions(cluster);
    const getScalingPolicy = yield* EMR.GetManagedScalingPolicy(cluster);
    const putScalingPolicy = yield* EMR.PutManagedScalingPolicy(cluster);
    const removeScalingPolicy = yield* EMR.RemoveManagedScalingPolicy(cluster);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: 10 });
        }

        // Submit a trivial shell step — proves AddJobFlowSteps and the
        // JobFlowId injection.
        if (request.method === "GET" && pathname === "/steps/add") {
          const { StepIds } = yield* addSteps({
            Steps: [
              {
                Name: "alchemy-echo",
                ActionOnFailure: "CONTINUE",
                HadoopJarStep: {
                  Jar: "command-runner.jar",
                  Args: ["bash", "-c", "echo alchemy"],
                },
              },
            ],
          });
          return yield* HttpServerResponse.json({ stepId: StepIds?.[0] });
        }

        if (request.method === "GET" && pathname === "/step") {
          const { Step } = yield* describeStep({
            StepId: url.searchParams.get("id")!,
          });
          return yield* HttpServerResponse.json({
            state: Step?.Status?.State,
            name: Step?.Name,
          });
        }

        if (request.method === "GET" && pathname === "/steps") {
          const { Steps } = yield* listSteps();
          return yield* HttpServerResponse.json({
            count: (Steps ?? []).length,
          });
        }

        // Cancellation of a completed step surfaces a per-step error reason
        // rather than failing the call — either shape proves the grant.
        if (request.method === "GET" && pathname === "/steps/cancel") {
          const { CancelStepsInfoList } = yield* cancelSteps({
            StepIds: [url.searchParams.get("id")!],
          });
          return yield* HttpServerResponse.json({
            status: CancelStepsInfoList?.[0]?.Status,
          });
        }

        if (request.method === "GET" && pathname === "/instances") {
          const { Instances } = yield* listInstances();
          return yield* HttpServerResponse.json({
            count: (Instances ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/groups") {
          const { InstanceGroups } = yield* listInstanceGroups();
          return yield* HttpServerResponse.json({
            types: (InstanceGroups ?? []).map((g) => g.InstanceGroupType),
          });
        }

        if (request.method === "GET" && pathname === "/bootstrap") {
          const { BootstrapActions } = yield* listBootstrapActions();
          return yield* HttpServerResponse.json({
            count: (BootstrapActions ?? []).length,
          });
        }

        // Managed scaling put -> get -> remove round trip. A master-only
        // cluster may reject the put with a typed validation tag — either
        // outcome proves the grants and the ClusterId injection.
        if (request.method === "GET" && pathname === "/scaling") {
          const putResult = yield* putScalingPolicy({
            ManagedScalingPolicy: {
              ComputeLimits: {
                UnitType: "Instances",
                MinimumCapacityUnits: 1,
                MaximumCapacityUnits: 4,
              },
            },
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          if (!putResult.ok) {
            return yield* HttpServerResponse.json(putResult);
          }
          const { ManagedScalingPolicy } = yield* getScalingPolicy();
          yield* removeScalingPolicy();
          return yield* HttpServerResponse.json({
            ok: true,
            max: ManagedScalingPolicy?.ComputeLimits?.MaximumCapacityUnits,
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
        EMR.AddJobFlowStepsHttp,
        EMR.DescribeStepHttp,
        EMR.ListStepsHttp,
        EMR.CancelStepsHttp,
        EMR.ListInstancesHttp,
        EMR.ListInstanceGroupsHttp,
        EMR.ListBootstrapActionsHttp,
        EMR.GetManagedScalingPolicyHttp,
        EMR.PutManagedScalingPolicyHttp,
        EMR.RemoveManagedScalingPolicyHttp,
      ),
    ),
  ),
);
