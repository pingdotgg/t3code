import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Layer from "effect/Layer";
import { makeKeyValueStoreScopedHttpBinding } from "./BindingHttp.ts";
import { GetKey } from "./GetKey.ts";

export const GetKeyHttp = Layer.effect(
  GetKey,
  makeKeyValueStoreScopedHttpBinding({
    tag: "AWS.CloudFront.GetKey",
    operation: kvs.getKey,
    actions: ["cloudfront-keyvaluestore:GetKey"],
  }),
);
