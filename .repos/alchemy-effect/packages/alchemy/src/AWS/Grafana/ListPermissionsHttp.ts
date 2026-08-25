import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { ListPermissions } from "./ListPermissions.ts";

export const ListPermissionsHttp = Layer.effect(
  ListPermissions,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.ListPermissions",
    operation: grafana.listPermissions,
    actions: ["grafana:ListPermissions"],
  }),
);
