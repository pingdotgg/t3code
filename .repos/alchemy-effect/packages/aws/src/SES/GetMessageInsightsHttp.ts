import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSESHttpBinding } from "./BindingHttp.ts";
import { GetMessageInsights } from "./GetMessageInsights.ts";

export const GetMessageInsightsHttp = Layer.effect(
  GetMessageInsights,
  makeSESHttpBinding({
    tag: "AWS.SES.GetMessageInsights",
    operation: sesv2.getMessageInsights,
    actions: ["ses:GetMessageInsights"],
  }),
);
