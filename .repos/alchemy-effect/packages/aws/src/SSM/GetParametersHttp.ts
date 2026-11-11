import * as SSM from "@distilled.cloud/aws/ssm";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import {
  GetParameters,
  type GetParametersParameters,
  type GetParametersRequest,
} from "./GetParameters.ts";

export const GetParametersHttp = Layer.effect(
  GetParameters,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getParameters = yield* AWSBindings.withCredentials(SSM.getParameters);

    return Effect.fn(function* (...parameters: GetParametersParameters) {
      // Resolve name accessors in caller order so the runtime request
      // preserves the order the user bound the parameters in.
      const NameAccessors: Effect.Effect<string>[] = [];
      for (const parameter of parameters) {
        NameAccessors.push(yield* parameter.parameterName);
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Sort by LogicalId so the binding identity (SID + ARN list) is
        // deterministic regardless of argument order.
        const sorted = [...parameters].sort((a, b) => a.LogicalId.localeCompare(b.LogicalId));
        yield* bind`AWS.SSM.GetParameters(${sorted})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["ssm:GetParameters"],
              Resource: sorted.map((parameter) => parameter.parameterArn),
            },
            {
              // kms:Decrypt so `WithDecryption: true` works on SecureString
              // parameters. Parameters without a key (String/StringList)
              // fall back to their own ARN, which matches no KMS key.
              Effect: "Allow",
              Action: ["kms:Decrypt"],
              Resource: sorted.map((parameter) =>
                Output.all(parameter.parameterArn, parameter.keyArn).pipe(
                  Output.map(([parameterArn, keyArn]) => keyArn ?? parameterArn),
                ),
              ),
            },
          ],
        });
      }
      return Effect.fn(
        `AWS.SSM.GetParameters(${parameters.map((parameter) => parameter.LogicalId).join(", ")})`,
      )(function* (request: GetParametersRequest = {}) {
        const names = yield* Effect.forEach(NameAccessors, (accessor) => accessor);
        return yield* getParameters({
          ...request,
          Names: names,
        });
      });
    });
  }),
);
