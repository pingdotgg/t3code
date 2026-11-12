import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Layer from "effect/Layer";
import { makeKeyValueStoreScopedHttpBinding } from "./BindingHttp.ts";
import { DescribeKeyValueStore } from "./DescribeKeyValueStore.ts";

export const DescribeKeyValueStoreHttp = Layer.effect(
  DescribeKeyValueStore,
  makeKeyValueStoreScopedHttpBinding({
    tag: "AWS.CloudFront.DescribeKeyValueStore",
    operation: kvs.describeKeyValueStore,
    actions: ["cloudfront-keyvaluestore:DescribeKeyValueStore"],
  }),
);
