import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Layer from "effect/Layer";
import { makeTransformerScopedHttpBinding } from "./BindingHttp.ts";
import { GetTransformerJob } from "./GetTransformerJob.ts";

export const GetTransformerJobHttp = Layer.effect(
  GetTransformerJob,
  makeTransformerScopedHttpBinding({
    tag: "AWS.B2BI.GetTransformerJob",
    operation: b2bi.getTransformerJob,
    actions: ["b2bi:GetTransformerJob"],
  }),
);
