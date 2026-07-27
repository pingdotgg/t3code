import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { InvokeCodeInterpreter } from "./InvokeCodeInterpreter.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export const InvokeCodeInterpreterHttp = Layer.effect(
  InvokeCodeInterpreter,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.InvokeCodeInterpreter",
    operation: agentcore.invokeCodeInterpreter,
    actions: ["bedrock-agentcore:InvokeCodeInterpreter"],
    requestKey: "codeInterpreterIdentifier",
    identifier: (codeInterpreter: CodeInterpreter) =>
      codeInterpreter.codeInterpreterId,
    arns: (codeInterpreter: CodeInterpreter) => [
      codeInterpreter.codeInterpreterArn,
    ],
  }),
);
