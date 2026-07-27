import * as redshift from "@distilled.cloud/aws/redshift";
import * as Layer from "effect/Layer";
import {
  clusterSnapshotArnPattern,
  makeRedshiftClusterHttpBinding,
} from "./BindingHttp.ts";
import { CreateClusterSnapshot } from "./CreateClusterSnapshot.ts";

export const CreateClusterSnapshotHttp = Layer.effect(
  CreateClusterSnapshot,
  makeRedshiftClusterHttpBinding({
    tag: "AWS.Redshift.CreateClusterSnapshot",
    operation: redshift.createClusterSnapshot,
    actions: ["redshift:CreateClusterSnapshot"],
    extraResources: (clusterArn) => [clusterSnapshotArnPattern(clusterArn)],
  }),
);
