import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Layer from "effect/Layer";
import { makeKeyValueStoreScopedHttpBinding } from "./BindingHttp.ts";
import { ListKeys } from "./ListKeys.ts";

export const ListKeysHttp = Layer.effect(
  ListKeys,
  makeKeyValueStoreScopedHttpBinding({
    tag: "AWS.CloudFront.ListKeys",
    operation: kvs.listKeys,
    actions: ["cloudfront-keyvaluestore:ListKeys"],
  }),
);
