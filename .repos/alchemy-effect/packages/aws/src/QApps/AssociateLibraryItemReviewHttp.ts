import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { AssociateLibraryItemReview } from "./AssociateLibraryItemReview.ts";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";

export const AssociateLibraryItemReviewHttp = Layer.effect(
  AssociateLibraryItemReview,
  makeQAppsInstanceHttpBinding({
    capability: "AssociateLibraryItemReview",
    iamActions: ["qapps:AssociateLibraryItemReview"],
    operation: qapps.associateLibraryItemReview,
  }),
);
