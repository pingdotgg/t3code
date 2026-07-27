import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import { makeDocDBElasticAccountHttpBinding } from "./BindingHttp.ts";
import { GetClusterSnapshot } from "./GetClusterSnapshot.ts";

export const GetClusterSnapshotHttp = Layer.effect(
  GetClusterSnapshot,
  makeDocDBElasticAccountHttpBinding({
    tag: "AWS.DocDBElastic.GetClusterSnapshot",
    operation: docdbelastic.getClusterSnapshot,
    actions: ["docdb-elastic:GetClusterSnapshot"],
  }),
);
