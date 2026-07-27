import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { GetCodeInterpreterSession } from "./GetCodeInterpreterSession.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export const GetCodeInterpreterSessionHttp = Layer.effect(
  GetCodeInterpreterSession,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.GetCodeInterpreterSession",
    operation: agentcore.getCodeInterpreterSession,
    actions: ["bedrock-agentcore:GetCodeInterpreterSession"],
    requestKey: "codeInterpreterIdentifier",
    identifier: (codeInterpreter: CodeInterpreter) =>
      codeInterpreter.codeInterpreterId,
    arns: (codeInterpreter: CodeInterpreter) => [
      codeInterpreter.codeInterpreterArn,
    ],
  }),
);
