import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { DescribeQAppPermissions } from "./DescribeQAppPermissions.ts";

export const DescribeQAppPermissionsHttp = Layer.effect(
  DescribeQAppPermissions,
  makeQAppHttpBinding({
    capability: "DescribeQAppPermissions",
    iamActions: ["qapps:DescribeQAppPermissions"],
    operation: qapps.describeQAppPermissions,
    injectAppId: true,
  }),
);
