import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { DisassociateLibraryItemReview } from "./DisassociateLibraryItemReview.ts";

export const DisassociateLibraryItemReviewHttp = Layer.effect(
  DisassociateLibraryItemReview,
  makeQAppsInstanceHttpBinding({
    capability: "DisassociateLibraryItemReview",
    iamActions: ["qapps:DisassociateLibraryItemReview"],
    operation: qapps.disassociateLibraryItemReview,
  }),
);
