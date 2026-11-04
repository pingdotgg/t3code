import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { UpdateWorkspaceConfiguration } from "./UpdateWorkspaceConfiguration.ts";

export const UpdateWorkspaceConfigurationHttp = Layer.effect(
  UpdateWorkspaceConfiguration,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.UpdateWorkspaceConfiguration",
    operation: grafana.updateWorkspaceConfiguration,
    actions: ["grafana:UpdateWorkspaceConfiguration"],
  }),
);
