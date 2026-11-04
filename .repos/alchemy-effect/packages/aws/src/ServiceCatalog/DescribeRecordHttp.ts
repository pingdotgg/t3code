import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { DescribeRecord } from "./DescribeRecord.ts";

export const DescribeRecordHttp = Layer.effect(
  DescribeRecord,
  makeServiceCatalogHttpBinding({
    capability: "DescribeRecord",
    iamActions: ["servicecatalog:DescribeRecord"],
    operation: servicecatalog.describeRecord,
  }),
);
