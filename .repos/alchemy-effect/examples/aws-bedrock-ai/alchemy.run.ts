import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import ChatFunction from "./src/ChatFunction.ts";

// AWS.providers() already provides AWSEnvironment from the SSO profile
// named by $AWS_PROFILE (defaults to "default").
const aws = AWS.providers();

export default Alchemy.Stack(
  "BedrockAI",
  {
    providers: aws,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const func = yield* ChatFunction;
    return {
      url: func.functionUrl,
      streamUrl: Output.interpolate`${func.functionUrl}stream?prompt=Write+a+haiku`,
      weatherUrl: Output.interpolate`${func.functionUrl}weather?prompt=What's+the+weather+in+Seattle%3F`,
    };
  }),
);
