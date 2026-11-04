import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { DisassociateLicense } from "./DisassociateLicense.ts";

export const DisassociateLicenseHttp = Layer.effect(
  DisassociateLicense,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.DisassociateLicense",
    operation: grafana.disassociateLicense,
    actions: ["grafana:DisassociateLicense"],
  }),
);
