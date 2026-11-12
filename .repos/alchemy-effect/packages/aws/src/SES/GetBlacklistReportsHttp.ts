import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSESHttpBinding } from "./BindingHttp.ts";
import { GetBlacklistReports } from "./GetBlacklistReports.ts";

export const GetBlacklistReportsHttp = Layer.effect(
  GetBlacklistReports,
  makeSESHttpBinding({
    tag: "AWS.SES.GetBlacklistReports",
    operation: sesv2.getBlacklistReports,
    actions: ["ses:GetBlacklistReports"],
  }),
);
