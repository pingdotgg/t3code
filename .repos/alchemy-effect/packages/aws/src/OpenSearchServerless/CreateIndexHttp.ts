import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import { CreateIndex } from "./CreateIndex.ts";

export const CreateIndexHttp = Layer.effect(
  CreateIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.CreateIndex",
    operation: aoss.createIndex,
    // IAM checks both: `aoss:CreateIndex` for the API call, and
    // `aoss:APIAccessAll` because the service reads the index through the
    // collection's data plane ("Access denied to head index" without it).
    // IAM has no narrower data-plane action; per-index permissions belong in
    // the collection's AccessPolicy.
    actions: ["aoss:CreateIndex", "aoss:APIAccessAll"],
  }),
);
