import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListMetricStreamsRequest
  extends cloudwatch.ListMetricStreamsInput {}

/**
 * Runtime binding for `cloudwatch:ListMetricStreams`.
 */
export class ListMetricStreams extends Binding.Service<
  ListMetricStreams,
  () => Effect.Effect<
    (
      request?: ListMetricStreamsRequest,
    ) => Effect.Effect<
      cloudwatch.ListMetricStreamsOutput,
      cloudwatch.ListMetricStreamsError
    >
  >
>()("AWS.CloudWatch.ListMetricStreams") {}

export const ListMetricStreamsLive = Layer.effect(
  ListMetricStreams,
  Effect.gen(function* () {
    const Policy = yield* ListMetricStreamsPolicy;
    const listMetricStreams = yield* cloudwatch.listMetricStreams;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: ListMetricStreamsRequest = {}) {
        return yield* listMetricStreams(request);
      });
    });
  }),
);

export class ListMetricStreamsPolicy extends Binding.Policy<
  ListMetricStreamsPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.ListMetricStreams") {}

export const ListMetricStreamsPolicyLive =
  ListMetricStreamsPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.ListMetricStreams())`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:ListMetricStreams"],
              Resource: ["*"],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `ListMetricStreamsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
