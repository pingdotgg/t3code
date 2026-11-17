import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import { DeleteIndex } from "./DeleteIndex.ts";

export const DeleteIndexHttp = Layer.effect(
  DeleteIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.DeleteIndex",
    operation: aoss.deleteIndex,
    // IAM checks both: `aoss:DeleteIndex` for the API call, and
    // `aoss:APIAccessAll` because the service reads the index through the
    // collection's data plane ("Access denied to head index" without it).
    // IAM has no narrower data-plane action; per-index permissions belong in
    // the collection's AccessPolicy.
    actions: ["aoss:DeleteIndex", "aoss:APIAccessAll"],
  }),
);
