import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import { makeDocDBElasticClusterHttpBinding } from "./BindingHttp.ts";
import { StartCluster } from "./StartCluster.ts";

export const StartClusterHttp = Layer.effect(
  StartCluster,
  makeDocDBElasticClusterHttpBinding({
    tag: "AWS.DocDBElastic.StartCluster",
    operation: docdbelastic.startCluster,
    actions: ["docdb-elastic:StartCluster"],
  }),
);
