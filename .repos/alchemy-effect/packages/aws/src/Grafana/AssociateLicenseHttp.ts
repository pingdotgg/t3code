import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { AssociateLicense } from "./AssociateLicense.ts";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";

export const AssociateLicenseHttp = Layer.effect(
  AssociateLicense,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.AssociateLicense",
    operation: grafana.associateLicense,
    actions: ["grafana:AssociateLicense"],
  }),
);
