import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeKinesisAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeAccountSettings } from "./DescribeAccountSettings.ts";

export const DescribeAccountSettingsHttp = Layer.effect(
  DescribeAccountSettings,
  makeKinesisAccountHttpBinding({
    tag: "AWS.Kinesis.DescribeAccountSettings",
    operation: Kinesis.describeAccountSettings,
    actions: ["kinesis:DescribeAccountSettings"],
  }),
);
