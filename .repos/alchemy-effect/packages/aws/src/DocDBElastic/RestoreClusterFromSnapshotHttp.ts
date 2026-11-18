import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import { makeDocDBElasticAccountHttpBinding } from "./BindingHttp.ts";
import { RestoreClusterFromSnapshot } from "./RestoreClusterFromSnapshot.ts";

export const RestoreClusterFromSnapshotHttp = Layer.effect(
  RestoreClusterFromSnapshot,
  makeDocDBElasticAccountHttpBinding({
    tag: "AWS.DocDBElastic.RestoreClusterFromSnapshot",
    operation: docdbelastic.restoreClusterFromSnapshot,
    actions: [
      "docdb-elastic:RestoreClusterFromSnapshot",
      // Restoring authorizes the creation of the new cluster as a
      // CreateCluster on `cluster/*` (verified live: without it the service
      // returns AccessDeniedException naming this action).
      "docdb-elastic:CreateCluster",
      "docdb-elastic:TagResource",
      // Restoring provisions a new cluster, which attaches to the VPC via a
      // service-managed VPC endpoint using the caller's EC2 permissions.
      "ec2:CreateVpcEndpoint",
      "ec2:DescribeVpcEndpoints",
      "ec2:DeleteVpcEndpoints",
      "ec2:ModifyVpcEndpoint",
      "ec2:DescribeVpcAttribute",
      "ec2:DescribeSubnets",
      "ec2:DescribeVpcs",
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeAccountAttributes",
      "ec2:DescribeSecurityGroups",
      "ec2:CreateTags",
    ],
  }),
);
