import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Layer from "effect/Layer";
import { makeRagHttpBinding } from "./BindingHttp.ts";
import { RetrieveAndGenerate } from "./RetrieveAndGenerate.ts";

export const RetrieveAndGenerateHttp = Layer.effect(
  RetrieveAndGenerate,
  makeRagHttpBinding({
    tag: "AWS.Bedrock.RetrieveAndGenerate",
    operation: bedrock.retrieveAndGenerate,
  }),
);
