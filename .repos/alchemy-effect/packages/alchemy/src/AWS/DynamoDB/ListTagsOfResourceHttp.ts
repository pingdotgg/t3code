import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableArnHttpBinding } from "./BindingHttp.ts";
import { ListTagsOfResource } from "./ListTagsOfResource.ts";

export const ListTagsOfResourceHttp = Layer.effect(
  ListTagsOfResource,
  makeTableArnHttpBinding({
    tag: "AWS.DynamoDB.ListTagsOfResource",
    key: "ResourceArn",
    operation: DynamoDB.listTagsOfResource,
    actions: ["dynamodb:ListTagsOfResource"],
  }),
);
