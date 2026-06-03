import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListDashboardsRequest extends cloudwatch.ListDashboardsInput {}

/**
 * Runtime binding for `cloudwatch:ListDashboards`.
 */
export class ListDashboards extends Binding.Service<
  ListDashboards,
  () => Effect.Effect<
    (
      request?: ListDashboardsRequest,
    ) => Effect.Effect<
      cloudwatch.ListDashboardsOutput,
      cloudwatch.ListDashboardsError
    >
  >
>()("AWS.CloudWatch.ListDashboards") {}

export const ListDashboardsLive = Layer.effect(
  ListDashboards,
  Effect.gen(function* () {
    const Policy = yield* ListDashboardsPolicy;
    const listDashboards = yield* cloudwatch.listDashboards;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: ListDashboardsRequest = {}) {
        return yield* listDashboards(request);
      });
    });
  }),
);

export class ListDashboardsPolicy extends Binding.Policy<
  ListDashboardsPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.ListDashboards") {}

export const ListDashboardsPolicyLive = ListDashboardsPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.CloudWatch.ListDashboards())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["cloudwatch:ListDashboards"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListDashboardsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
