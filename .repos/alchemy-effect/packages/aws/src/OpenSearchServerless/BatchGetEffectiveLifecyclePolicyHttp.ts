import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { BatchGetEffectiveLifecyclePolicy } from "./BatchGetEffectiveLifecyclePolicy.ts";
import { makeAossAccountHttpBinding } from "./BindingHttp.ts";

export const BatchGetEffectiveLifecyclePolicyHttp = Layer.effect(
  BatchGetEffectiveLifecyclePolicy,
  makeAossAccountHttpBinding({
    tag: "AWS.OpenSearchServerless.BatchGetEffectiveLifecyclePolicy",
    operation: aoss.batchGetEffectiveLifecyclePolicy,
    actions: ["aoss:BatchGetEffectiveLifecyclePolicy"],
  }),
);
