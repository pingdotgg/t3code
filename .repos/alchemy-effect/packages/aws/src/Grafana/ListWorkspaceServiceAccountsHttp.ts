import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { ListWorkspaceServiceAccounts } from "./ListWorkspaceServiceAccounts.ts";

export const ListWorkspaceServiceAccountsHttp = Layer.effect(
  ListWorkspaceServiceAccounts,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.ListWorkspaceServiceAccounts",
    operation: grafana.listWorkspaceServiceAccounts,
    actions: ["grafana:ListWorkspaceServiceAccounts"],
  }),
);
