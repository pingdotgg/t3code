import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelineJobHttpBinding } from "./BindingHttp.ts";
import { PutJobSuccessResult } from "./PutJobSuccessResult.ts";

export const PutJobSuccessResultHttp = Layer.effect(
  PutJobSuccessResult,
  makeCodePipelineJobHttpBinding({
    tag: "AWS.CodePipeline.PutJobSuccessResult",
    operation: codepipeline.putJobSuccessResult,
    actions: ["codepipeline:PutJobSuccessResult"],
  }),
);
