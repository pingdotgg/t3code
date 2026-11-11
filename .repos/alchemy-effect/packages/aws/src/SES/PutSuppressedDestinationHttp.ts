import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSESHttpBinding } from "./BindingHttp.ts";
import { PutSuppressedDestination } from "./PutSuppressedDestination.ts";

export const PutSuppressedDestinationHttp = Layer.effect(
  PutSuppressedDestination,
  makeSESHttpBinding({
    tag: "AWS.SES.PutSuppressedDestination",
    operation: sesv2.putSuppressedDestination,
    actions: ["ses:PutSuppressedDestination"],
  }),
);
