import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { bedrockModelArns } from "./ModelArns.ts";
import { Rerank, type RerankRequest } from "./Rerank.ts";

// Bespoke (not the shared model-scoped scaffold): Rerank authorizes the
// `bedrock:Rerank` action only against `*`, alongside model-scoped
// `bedrock:InvokeModel`, and the model is referenced inside
// `rerankingConfiguration` rather than a top-level `modelId`.
export const RerankHttp = Layer.effect(
  Rerank,
  Effect.gen(function* () {
    const rerank = yield* bedrock.rerank;

    return Effect.fn(function* (model: string, ...additionalModels: string[]) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          // Sort so the binding identity (SID + ARN list) is deterministic
          // regardless of argument order.
          const sorted = [...new Set([model, ...additionalModels])].sort();
          yield* host.bind`Allow(${host}, AWS.Bedrock.Rerank(${sorted.join(",")}))`(
            {
              policyStatements: [
                {
                  // bedrock:Rerank does not support resource-level scoping.
                  Effect: "Allow",
                  Action: ["bedrock:Rerank"],
                  Resource: ["*"],
                },
                {
                  Effect: "Allow",
                  Action: ["bedrock:InvokeModel"],
                  Resource: [
                    ...new Set(
                      sorted.flatMap((id) =>
                        bedrockModelArns(region, accountId, id),
                      ),
                    ),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Bedrock.Rerank(${model})`)(function* (
        request: RerankRequest,
      ) {
        return yield* rerank(request);
      });
    });
  }),
);
