import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { UpdateProvisionedProduct } from "./UpdateProvisionedProduct.ts";

export const UpdateProvisionedProductHttp = Layer.effect(
  UpdateProvisionedProduct,
  makeServiceCatalogHttpBinding({
    capability: "UpdateProvisionedProduct",
    iamActions: [
      "servicecatalog:UpdateProvisionedProduct",
      "cloudformation:UpdateStack",
      "cloudformation:CreateChangeSet",
      "cloudformation:DescribeChangeSet",
      "cloudformation:ExecuteChangeSet",
      "cloudformation:DeleteChangeSet",
      "cloudformation:DescribeStacks",
      "cloudformation:DescribeStackEvents",
      "cloudformation:GetTemplateSummary",
      "cloudformation:SetStackPolicy",
      "cloudformation:ValidateTemplate",
      "s3:GetObject",
    ],
    operation: servicecatalog.updateProvisionedProduct,
  }),
);
