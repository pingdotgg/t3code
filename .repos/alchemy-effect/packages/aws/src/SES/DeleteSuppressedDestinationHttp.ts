import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSESHttpBinding } from "./BindingHttp.ts";
import { DeleteSuppressedDestination } from "./DeleteSuppressedDestination.ts";

export const DeleteSuppressedDestinationHttp = Layer.effect(
  DeleteSuppressedDestination,
  makeSESHttpBinding({
    tag: "AWS.SES.DeleteSuppressedDestination",
    operation: sesv2.deleteSuppressedDestination,
    actions: ["ses:DeleteSuppressedDestination"],
  }),
);
