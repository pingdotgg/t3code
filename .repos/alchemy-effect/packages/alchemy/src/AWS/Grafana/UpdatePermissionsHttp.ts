import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { UpdatePermissions } from "./UpdatePermissions.ts";

export const UpdatePermissionsHttp = Layer.effect(
  UpdatePermissions,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.UpdatePermissions",
    operation: grafana.updatePermissions,
    actions: ["grafana:UpdatePermissions"],
  }),
);
