import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { ListWorkspaceServiceAccountTokens } from "./ListWorkspaceServiceAccountTokens.ts";

export const ListWorkspaceServiceAccountTokensHttp = Layer.effect(
  ListWorkspaceServiceAccountTokens,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.ListWorkspaceServiceAccountTokens",
    operation: grafana.listWorkspaceServiceAccountTokens,
    actions: ["grafana:ListWorkspaceServiceAccountTokens"],
  }),
);
