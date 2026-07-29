import * as AWS from "@/AWS";
import {
  AutoScalingGroup,
  CompleteLifecycleAction,
  CompleteLifecycleActionHttp,
  consumeLifecycleActions,
  LaunchTemplate,
} from "@/AWS/AutoScaling";
import { amazonLinux2023 } from "@/AWS/EC2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { getAutoScalingTestSubnetId } from "../TestNetwork.ts";

export const lifecycleFleetAsgName = "alchemy-test-lifecycle-e2e-asg";
export const lifecycleHookName = "alchemy-test-lifecycle-e2e-hook";

export class LifecycleTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "LifecycleTestFunction",
) {}

/**
 * Shared fleet for the lifecycle-hook E2E: a launch template + Auto Scaling
 * Group sized to zero (no instances launch by default). Subnet/AMI are resolved
 * only at deploy time — at runtime the ASG resolves to a reference, so the
 * lookups are guarded off inside the deployed Lambda.
 */
export class LifecycleFleet extends Context.Service<
  LifecycleFleet,
  { group: AutoScalingGroup }
>()("AutoScalingLifecycleFleet") {}

export const LifecycleFleetLive = Layer.effect(
  LifecycleFleet,
  Effect.gen(function* () {
    const isDeploy = !globalThis.__ALCHEMY_RUNTIME__;
    const imageId = isDeploy
      ? ((yield* amazonLinux2023()) ?? "ami-00000000000000000")
      : "ami-00000000000000000";
    const subnetId = isDeploy
      ? yield* getAutoScalingTestSubnetId.pipe(Effect.orDie)
      : ("subnet-0" as `subnet-${string}`);

    const template = yield* LaunchTemplate("LifecycleTemplate", {
      imageId,
      instanceType: "t3.micro",
    });
    const group = yield* AutoScalingGroup("LifecycleGroup", {
      autoScalingGroupName: lifecycleFleetAsgName,
      launchTemplate: template,
      subnetIds: [subnetId],
      minSize: 0,
      maxSize: 0,
      desiredCapacity: 0,
    });
    return { group };
  }),
);

export default LifecycleTestFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const { group } = yield* LifecycleFleet;
    const lifecycle = yield* CompleteLifecycleAction(group);

    // Register the launch lifecycle hook + EventBridge subscription. Instances
    // that enter the wait state are drained by signalling CONTINUE.
    yield* consumeLifecycleActions(
      group,
      {
        lifecycleHookName,
        lifecycleTransition: "LAUNCHING",
        heartbeatTimeout: "300 seconds",
        defaultResult: "ABANDON",
      },
      (events) =>
        Stream.runForEach(events, (event) =>
          lifecycle
            .complete({
              LifecycleHookName: event.detail.LifecycleHookName,
              LifecycleActionToken: event.detail.LifecycleActionToken,
              LifecycleActionResult: "CONTINUE",
            })
            .pipe(Effect.orDie),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        // Exercise the CompleteLifecycleAction binding directly with a
        // non-existent action token: AWS rejects it (typed `ValidationError`)
        // rather than AccessDenied, proving the IAM policy the binding attached
        // is correct. Returns the error tag so the test can assert wiring.
        if (request.method === "POST" && pathname === "/complete-bogus") {
          const result = yield* lifecycle
            .complete({
              LifecycleHookName: lifecycleHookName,
              LifecycleActionToken: "00000000-0000-0000-0000-000000000000",
              LifecycleActionResult: "CONTINUE",
            })
            .pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
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
        CompleteLifecycleActionHttp,
        LifecycleFleetLive,
      ),
    ),
  ),
);
