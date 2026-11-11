import * as redshift from "@distilled.cloud/aws/redshift";
import * as Layer from "effect/Layer";
import { makeRedshiftClusterHttpBinding } from "./BindingHttp.ts";
import { RebootCluster } from "./RebootCluster.ts";

export const RebootClusterHttp = Layer.effect(
  RebootCluster,
  makeRedshiftClusterHttpBinding({
    tag: "AWS.Redshift.RebootCluster",
    operation: redshift.rebootCluster,
    actions: ["redshift:RebootCluster"],
  }),
);
