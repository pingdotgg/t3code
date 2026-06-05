import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface TestEventPatternRequest
  extends eventbridge.TestEventPatternRequest {}

export class TestEventPattern extends Binding.Service<
  TestEventPattern,
  () => Effect.Effect<
    (
      request: TestEventPatternRequest,
    ) => Effect.Effect<
      eventbridge.TestEventPatternResponse,
      eventbridge.TestEventPatternError
    >
  >
>()("AWS.EventBridge.TestEventPattern") {}

export const TestEventPatternLive = Layer.effect(
  TestEventPattern,
  Effect.gen(function* () {
    const Policy = yield* TestEventPatternPolicy;
    const testEventPattern = yield* eventbridge.testEventPattern;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: TestEventPatternRequest) {
        return yield* testEventPattern(request);
      });
    });
  }),
);

export class TestEventPatternPolicy extends Binding.Policy<
  TestEventPatternPolicy,
  () => Effect.Effect<void>
>()("AWS.EventBridge.TestEventPattern") {}

export const TestEventPatternPolicyLive = TestEventPatternPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.EventBridge.TestEventPattern())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["events:TestEventPattern"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `TestEventPatternPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
