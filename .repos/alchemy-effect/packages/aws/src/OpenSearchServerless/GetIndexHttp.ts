import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import { GetIndex } from "./GetIndex.ts";

export const GetIndexHttp = Layer.effect(
  GetIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.GetIndex",
    operation: aoss.getIndex,
    // IAM checks both: `aoss:GetIndex` for the API call, and
    // `aoss:APIAccessAll` because the service reads the index through the
    // collection's data plane ("Access denied to head index" without it).
    // IAM has no narrower data-plane action; per-index permissions belong in
    // the collection's AccessPolicy.
    actions: ["aoss:GetIndex", "aoss:APIAccessAll"],
  }),
);
