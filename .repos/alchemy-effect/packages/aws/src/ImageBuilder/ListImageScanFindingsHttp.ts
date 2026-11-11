import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListImageScanFindings } from "./ListImageScanFindings.ts";

export const ListImageScanFindingsHttp = Layer.effect(
  ListImageScanFindings,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListImageScanFindings",
    operation: imagebuilder.listImageScanFindings,
    // Image Builder serves scan findings from Amazon Inspector, so the API
    // authorizes the dependent inspector2 action too — without it the call
    // fails with AccessDeniedException even when the imagebuilder action is
    // granted.
    actions: ["imagebuilder:ListImageScanFindings", "inspector2:ListFindings"],
  }),
);
