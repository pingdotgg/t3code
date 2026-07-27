import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import {
  getTaggableResourceArn,
  type TaggableResource,
} from "./binding-common.ts";
import { makeCloudWatchResourceHttpBinding } from "./BindingHttp.ts";
import { ListTagsForResource } from "./ListTagsForResource.ts";

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  makeCloudWatchResourceHttpBinding({
    tag: "AWS.CloudWatch.ListTagsForResource",
    operation: cloudwatch.listTagsForResource,
    actions: ["cloudwatch:ListTagsForResource"],
    requestKey: "ResourceARN",
    identifier: (resource: TaggableResource) =>
      getTaggableResourceArn(resource),
    resourceArn: (resource: TaggableResource) =>
      getTaggableResourceArn(resource),
  }),
);
