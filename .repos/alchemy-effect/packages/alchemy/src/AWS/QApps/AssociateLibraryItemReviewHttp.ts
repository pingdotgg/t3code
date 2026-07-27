import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { AssociateLibraryItemReview } from "./AssociateLibraryItemReview.ts";

export const AssociateLibraryItemReviewHttp = Layer.effect(
  AssociateLibraryItemReview,
  makeQAppsInstanceHttpBinding({
    capability: "AssociateLibraryItemReview",
    iamActions: ["qapps:AssociateLibraryItemReview"],
    operation: qapps.associateLibraryItemReview,
  }),
);
