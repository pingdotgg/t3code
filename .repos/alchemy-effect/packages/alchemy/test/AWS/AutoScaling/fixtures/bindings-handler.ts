import * as AWS from "@/AWS";
import {
  AutoScalingGroup,
  consumeInstanceEvents,
  DescribeAutoScalingGroup,
  DescribeAutoScalingGroupHttp,
  DescribeScalingActivities,
  DescribeScalingActivitiesHttp,
  ExecutePolicy,
  ExecutePolicyHttp,
  InstanceRefresh,
  InstanceRefreshHttp,
  LaunchTemplate,
  SetDesiredCapacity,
  SetDesiredCapacityHttp,
  SetInstanceHealth,
  SetInstanceHealthHttp,
  SetInstanceProtection,
  SetInstanceProtectionHttp,
  Standby,
  StandbyHttp,
  TerminateInstanceInAutoScalingGroup,
  TerminateInstanceInAutoScalingGroupHttp,
} from "@/AWS/AutoScaling";
import { amazonLinux2023 } from "@/AWS/EC2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { getAutoScalingTestSubnetId } from "../TestNetwork.ts";

export const bindingsAsgName = "alchemy-test-asg-bindings-asg";

/** A well-formed instance id that does not exist — probes reach the service
 * (proving credentials + IAM) and come back as a typed `ValidationError`. */
const bogusInstanceId = "i-00000000000000000";

export class AsgBindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "AsgBindingsFunction",
) {}

/**
 * Shared fleet for the bindings E2E: a launch template + Auto Scaling Group
 * sized to zero (no instances launch). Subnet/AMI are resolved only at deploy
 * time — at runtime the ASG resolves to a reference, so the lookups are
 * guarded off inside the deployed Lambda.
 */
export class BindingsFleet extends Context.Service<
  BindingsFleet,
  { group: AutoScalingGroup }
>()("AutoScalingBindingsFleet") {}

export const BindingsFleetLive = Layer.effect(
  BindingsFleet,
  Effect.gen(function* () {
    const isDeploy = !globalThis.__ALCHEMY_RUNTIME__;
    const imageId = isDeploy
      ? ((yield* amazonLinux2023()) ?? "ami-00000000000000000")
      : "ami-00000000000000000";
    const subnetId = isDeploy
      ? yield* getAutoScalingTestSubnetId.pipe(Effect.orDie)
      : ("subnet-0" as `subnet-${string}`);

    const template = yield* LaunchTemplate("BindingsTemplate", {
      imageId,
      instanceType: "t3.micro",
    });
    const group = yield* AutoScalingGroup("BindingsGroup", {
      autoScalingGroupName: bindingsAsgName,
      launchTemplate: template,
      subnetIds: [subnetId],
      minSize: 0,
      maxSize: 0,
      desiredCapacity: 0,
    });
    return { group };
  }),
);

export default AsgBindingsFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const { group } = yield* BindingsFleet;

    const describeGroup = yield* DescribeAutoScalingGroup(group);
    const describeActivities = yield* DescribeScalingActivities(group);
    const setDesiredCapacity = yield* SetDesiredCapacity(group);
    const executePolicy = yield* ExecutePolicy(group);
    const setInstanceHealth = yield* SetInstanceHealth(group);
    const setInstanceProtection = yield* SetInstanceProtection(group);
    const terminateInstance = yield* TerminateInstanceInAutoScalingGroup(group);
    const standby = yield* Standby(group);
    const refresh = yield* InstanceRefresh(group);

    // Subscribe to completed launch/terminate scaling activities (creates the
    // EventBridge rule at deploy time).
    yield* consumeInstanceEvents(group, {}, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `${event["detail-type"]}: ${event.detail.EC2InstanceId} in ${event.detail.AutoScalingGroupName}`,
        ),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/describe") {
          const result = yield* describeGroup().pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            name:
              result._tag === "Success"
                ? result.success?.AutoScalingGroupName
                : undefined,
            maxSize:
              result._tag === "Success" ? result.success?.MaxSize : undefined,
          });
        }

        if (request.method === "GET" && pathname === "/activities") {
          const result = yield* describeActivities({ MaxRecords: 10 }).pipe(
            Effect.result,
          );
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            count:
              result._tag === "Success"
                ? (result.success.Activities ?? []).length
                : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/set-desired") {
          const result = yield* setDesiredCapacity({
            DesiredCapacity: 0,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        // Executes a policy that doesn't exist: AWS rejects it with a typed
        // `ValidationError` rather than AccessDenied, proving the IAM policy
        // the binding attached is correct.
        if (request.method === "POST" && pathname === "/execute-policy") {
          const result = yield* executePolicy({
            PolicyName: "alchemy-test-bogus-policy",
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        // Instance-scoped operation: the request carries no group name, so
        // EC2 Auto Scaling resolves the instance's owning group for
        // resource-level authorization. A bogus instance resolves to nothing,
        // which the (correct, least-privilege) group-scoped grant denies.
        if (request.method === "POST" && pathname === "/set-health") {
          const result = yield* setInstanceHealth({
            InstanceId: bogusInstanceId,
            HealthStatus: "Unhealthy",
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        if (request.method === "POST" && pathname === "/set-protection") {
          const result = yield* setInstanceProtection({
            InstanceIds: [bogusInstanceId],
            ProtectedFromScaleIn: true,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        // Instance-scoped like /set-health above — see that comment.
        if (request.method === "POST" && pathname === "/terminate") {
          const result = yield* terminateInstance({
            InstanceId: bogusInstanceId,
            ShouldDecrementDesiredCapacity: false,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        if (request.method === "POST" && pathname === "/standby-enter") {
          const result = yield* standby
            .enter({
              InstanceIds: [bogusInstanceId],
              ShouldDecrementDesiredCapacity: true,
            })
            .pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        if (request.method === "POST" && pathname === "/standby-exit") {
          const result = yield* standby
            .exit({ InstanceIds: [bogusInstanceId] })
            .pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        // Full instance-refresh cycle on the zero-instance fleet: start
        // succeeds (and completes immediately with nothing to replace),
        // describe lists it, cancel tolerates the already-finished refresh.
        if (request.method === "POST" && pathname === "/refresh") {
          const started = yield* refresh.start().pipe(Effect.result);
          const startTag =
            started._tag === "Failure" ? started.failure._tag : "Success";

          const described = yield* refresh.describe().pipe(Effect.result);
          const describeOk = described._tag === "Success";
          const describeCount =
            described._tag === "Success"
              ? (described.success.InstanceRefreshes ?? []).length
              : undefined;

          const cancelled = yield* refresh.cancel().pipe(
            Effect.catchTag("ActiveInstanceRefreshNotFoundFault", () =>
              Effect.succeed({ InstanceRefreshId: undefined }),
            ),
            Effect.result,
          );
          const cancelTag =
            cancelled._tag === "Failure" ? cancelled.failure._tag : "Success";

          return yield* HttpServerResponse.json({
            startTag,
            describeOk,
            describeCount,
            cancelTag,
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
        AWS.Lambda.EventSource,
        DescribeAutoScalingGroupHttp,
        DescribeScalingActivitiesHttp,
        SetDesiredCapacityHttp,
        ExecutePolicyHttp,
        SetInstanceHealthHttp,
        SetInstanceProtectionHttp,
        TerminateInstanceInAutoScalingGroupHttp,
        StandbyHttp,
        InstanceRefreshHttp,
        BindingsFleetLive,
      ),
    ),
  ),
);
