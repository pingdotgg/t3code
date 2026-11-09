import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { DescribeWorkspaceConfiguration } from "./DescribeWorkspaceConfiguration.ts";

export const DescribeWorkspaceConfigurationHttp = Layer.effect(
  DescribeWorkspaceConfiguration,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.DescribeWorkspaceConfiguration",
    operation: grafana.describeWorkspaceConfiguration,
    actions: ["grafana:DescribeWorkspaceConfiguration"],
  }),
);
