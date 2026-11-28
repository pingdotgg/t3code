import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaAccountHttpBinding } from "./BindingHttp.ts";
import { ListVersions } from "./ListVersions.ts";

export const ListVersionsHttp = Layer.effect(
  ListVersions,
  makeGrafanaAccountHttpBinding({
    tag: "AWS.Grafana.ListVersions",
    operation: grafana.listVersions,
    actions: ["grafana:ListVersions"],
  }),
);
