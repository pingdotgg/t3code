import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Layer from "effect/Layer";
import { makeMediaConvertHttpBinding } from "./BindingHttp.ts";
import { Probe } from "./Probe.ts";

export const ProbeHttp = Layer.effect(
  Probe,
  makeMediaConvertHttpBinding({
    capability: "Probe",
    iamActions: ["mediaconvert:Probe"],
    operation: mediaconvert.probe,
  }),
);
