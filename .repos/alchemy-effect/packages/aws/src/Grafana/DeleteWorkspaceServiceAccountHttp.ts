import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { DeleteWorkspaceServiceAccount } from "./DeleteWorkspaceServiceAccount.ts";

export const DeleteWorkspaceServiceAccountHttp = Layer.effect(
  DeleteWorkspaceServiceAccount,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.DeleteWorkspaceServiceAccount",
    operation: grafana.deleteWorkspaceServiceAccount,
    actions: ["grafana:DeleteWorkspaceServiceAccount"],
  }),
);
