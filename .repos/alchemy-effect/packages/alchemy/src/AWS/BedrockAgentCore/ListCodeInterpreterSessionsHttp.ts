import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { ListCodeInterpreterSessions } from "./ListCodeInterpreterSessions.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export const ListCodeInterpreterSessionsHttp = Layer.effect(
  ListCodeInterpreterSessions,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListCodeInterpreterSessions",
    operation: agentcore.listCodeInterpreterSessions,
    actions: ["bedrock-agentcore:ListCodeInterpreterSessions"],
    requestKey: "codeInterpreterIdentifier",
    identifier: (codeInterpreter: CodeInterpreter) =>
      codeInterpreter.codeInterpreterId,
    arns: (codeInterpreter: CodeInterpreter) => [
      codeInterpreter.codeInterpreterArn,
    ],
  }),
);
