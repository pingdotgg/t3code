import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { CreateWorkspaceServiceAccount } from "./CreateWorkspaceServiceAccount.ts";

export const CreateWorkspaceServiceAccountHttp = Layer.effect(
  CreateWorkspaceServiceAccount,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.CreateWorkspaceServiceAccount",
    operation: grafana.createWorkspaceServiceAccount,
    actions: ["grafana:CreateWorkspaceServiceAccount"],
  }),
);
