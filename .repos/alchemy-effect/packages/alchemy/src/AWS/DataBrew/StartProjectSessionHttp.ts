import * as databrew from "@distilled.cloud/aws/databrew";
import * as Layer from "effect/Layer";
import { makeDataBrewProjectHttpBinding } from "./BindingHttp.ts";
import { StartProjectSession } from "./StartProjectSession.ts";

export const StartProjectSessionHttp = Layer.effect(
  StartProjectSession,
  makeDataBrewProjectHttpBinding({
    tag: "AWS.DataBrew.StartProjectSession",
    operation: databrew.startProjectSession,
    actions: ["databrew:StartProjectSession"],
  }),
);
