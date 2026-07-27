import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import { DeleteIndex } from "./DeleteIndex.ts";

export const DeleteIndexHttp = Layer.effect(
  DeleteIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.DeleteIndex",
    operation: aoss.deleteIndex,
    actions: ["aoss:APIAccessAll"],
  }),
);
