import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { UpdateWorkspaceAuthentication } from "./UpdateWorkspaceAuthentication.ts";

export const UpdateWorkspaceAuthenticationHttp = Layer.effect(
  UpdateWorkspaceAuthentication,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.UpdateWorkspaceAuthentication",
    operation: grafana.updateWorkspaceAuthentication,
    actions: ["grafana:UpdateWorkspaceAuthentication"],
  }),
);
