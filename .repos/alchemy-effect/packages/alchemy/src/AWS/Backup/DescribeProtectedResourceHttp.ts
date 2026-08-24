import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeProtectedResource } from "./DescribeProtectedResource.ts";

export const DescribeProtectedResourceHttp = Layer.effect(
  DescribeProtectedResource,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.DescribeProtectedResource",
    operation: backup.describeProtectedResource,
    actions: ["backup:DescribeProtectedResource"],
  }),
);
