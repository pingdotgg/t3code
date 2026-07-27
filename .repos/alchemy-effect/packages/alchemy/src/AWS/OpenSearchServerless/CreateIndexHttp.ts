import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import { CreateIndex } from "./CreateIndex.ts";

export const CreateIndexHttp = Layer.effect(
  CreateIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.CreateIndex",
    operation: aoss.createIndex,
    actions: ["aoss:APIAccessAll"],
  }),
);
