import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import { UpdateIndex } from "./UpdateIndex.ts";

export const UpdateIndexHttp = Layer.effect(
  UpdateIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.UpdateIndex",
    operation: aoss.updateIndex,
    actions: ["aoss:APIAccessAll"],
  }),
);
