import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSESHttpBinding } from "./BindingHttp.ts";
import { GetSuppressedDestination } from "./GetSuppressedDestination.ts";

export const GetSuppressedDestinationHttp = Layer.effect(
  GetSuppressedDestination,
  makeSESHttpBinding({
    tag: "AWS.SES.GetSuppressedDestination",
    operation: sesv2.getSuppressedDestination,
    actions: ["ses:GetSuppressedDestination"],
  }),
);
