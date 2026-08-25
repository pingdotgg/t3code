import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import { GetIndex } from "./GetIndex.ts";

export const GetIndexHttp = Layer.effect(
  GetIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.GetIndex",
    operation: aoss.getIndex,
    actions: ["aoss:APIAccessAll"],
  }),
);
