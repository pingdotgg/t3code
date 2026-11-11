import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";
import { InvokeCodeInterpreter } from "./InvokeCodeInterpreter.ts";

export const InvokeCodeInterpreterHttp = Layer.effect(
  InvokeCodeInterpreter,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.InvokeCodeInterpreter",
    operation: agentcore.invokeCodeInterpreter,
    actions: ["bedrock-agentcore:InvokeCodeInterpreter"],
    requestKey: "codeInterpreterIdentifier",
    identifier: (codeInterpreter: CodeInterpreter) => codeInterpreter.codeInterpreterId,
    arns: (codeInterpreter: CodeInterpreter) => [codeInterpreter.codeInterpreterArn],
  }),
);
