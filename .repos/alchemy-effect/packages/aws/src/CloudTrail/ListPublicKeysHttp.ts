import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Layer from "effect/Layer";
import { makeCloudTrailAccountHttpBinding } from "./BindingHttp.ts";
import { ListPublicKeys } from "./ListPublicKeys.ts";

export const ListPublicKeysHttp = Layer.effect(
  ListPublicKeys,
  makeCloudTrailAccountHttpBinding({
    tag: "AWS.CloudTrail.ListPublicKeys",
    operation: cloudtrail.listPublicKeys,
    actions: ["cloudtrail:ListPublicKeys"],
  }),
);
