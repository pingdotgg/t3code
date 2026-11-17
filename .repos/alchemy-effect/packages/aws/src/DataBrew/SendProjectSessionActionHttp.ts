import * as databrew from "@distilled.cloud/aws/databrew";
import * as Layer from "effect/Layer";
import { makeDataBrewProjectHttpBinding } from "./BindingHttp.ts";
import { SendProjectSessionAction } from "./SendProjectSessionAction.ts";

export const SendProjectSessionActionHttp = Layer.effect(
  SendProjectSessionAction,
  makeDataBrewProjectHttpBinding({
    tag: "AWS.DataBrew.SendProjectSessionAction",
    operation: databrew.sendProjectSessionAction,
    actions: ["databrew:SendProjectSessionAction"],
  }),
);
