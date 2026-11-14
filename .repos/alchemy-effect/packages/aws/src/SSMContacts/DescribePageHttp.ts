import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { DescribePage } from "./DescribePage.ts";

export const DescribePageHttp = Layer.effect(
  DescribePage,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.DescribePage",
    operation: ssm.describePage,
    actions: ["ssm-contacts:DescribePage"],
  }),
);
