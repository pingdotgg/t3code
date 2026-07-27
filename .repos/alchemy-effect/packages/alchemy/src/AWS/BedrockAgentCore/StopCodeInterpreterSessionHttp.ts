import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { StopCodeInterpreterSession } from "./StopCodeInterpreterSession.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export const StopCodeInterpreterSessionHttp = Layer.effect(
  StopCodeInterpreterSession,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.StopCodeInterpreterSession",
    operation: agentcore.stopCodeInterpreterSession,
    actions: ["bedrock-agentcore:StopCodeInterpreterSession"],
    requestKey: "codeInterpreterIdentifier",
    identifier: (codeInterpreter: CodeInterpreter) =>
      codeInterpreter.codeInterpreterId,
    arns: (codeInterpreter: CodeInterpreter) => [
      codeInterpreter.codeInterpreterArn,
    ],
  }),
);
