import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSESHttpBinding } from "./BindingHttp.ts";
import { ListSuppressedDestinations } from "./ListSuppressedDestinations.ts";

export const ListSuppressedDestinationsHttp = Layer.effect(
  ListSuppressedDestinations,
  makeSESHttpBinding({
    tag: "AWS.SES.ListSuppressedDestinations",
    operation: sesv2.listSuppressedDestinations,
    actions: ["ses:ListSuppressedDestinations"],
  }),
);
