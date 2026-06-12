import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import ServiceFunction from "./src/ServiceFunction.ts";

const aws = AWS.providers();

export default Alchemy.Stack(
  "AwsRdsExample",
  { providers: aws, state: Alchemy.localState() },
  Effect.gen(function* () {
    const service = yield* ServiceFunction;
    return {
      url: service.functionUrl,
    };
  }),
);
