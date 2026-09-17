import * as AWS from "@/AWS";
import {
  DescribeInstance,
  DescribeInstanceHttp,
  DescribeInstanceStatus,
  DescribeInstanceStatusHttp,
} from "@/AWS/EC2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import DevInstance from "./dev-instance.ts";

export class Ec2DevProbeFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "Ec2DevProbeFunction",
) {}

/**
 * Lambda fixture for the EC2 local dev test: binds the EC2 instance
 * observation capabilities to the hosted {@link DevInstance} and exposes
 * one route per binding. Under `alchemy dev` the function runs in the
 * floci emulator, so a 200 from `/describe` proves the full chain —
 * emulated Lambda → EC2 control plane binding → emulated instance —
 * without any real cloud.
 */
export default Ec2DevProbeFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
    timeout: Duration.seconds(30),
    memorySize: 512,
  },
  Effect.gen(function* () {
    const describeInstance = yield* DescribeInstance(DevInstance);
    const describeStatus = yield* DescribeInstanceStatus(DevInstance);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://probe");

        if (url.pathname === "/describe") {
          const result = yield* describeInstance().pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            state:
              result._tag === "Success"
                ? result.success?.State?.Name
                : undefined,
            instanceId:
              result._tag === "Success"
                ? result.success?.InstanceId
                : undefined,
          });
        }

        if (url.pathname === "/status") {
          const result = yield* describeStatus({
            IncludeAllInstances: true,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            count:
              result._tag === "Success"
                ? (result.success.InstanceStatuses?.length ?? 0)
                : undefined,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname: url.pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(DescribeInstanceHttp, DescribeInstanceStatusHttp),
    ),
  ),
);
