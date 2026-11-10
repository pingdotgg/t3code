import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import { UpdateIndex } from "./UpdateIndex.ts";

export const UpdateIndexHttp = Layer.effect(
  UpdateIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.UpdateIndex",
    operation: aoss.updateIndex,
    // IAM checks both: `aoss:UpdateIndex` for the API call, and
    // `aoss:APIAccessAll` because the service reads the index through the
    // collection's data plane ("Access denied to head index" without it).
    // IAM has no narrower data-plane action; per-index permissions belong in
    // the collection's AccessPolicy.
    actions: ["aoss:UpdateIndex", "aoss:APIAccessAll"],
  }),
);
