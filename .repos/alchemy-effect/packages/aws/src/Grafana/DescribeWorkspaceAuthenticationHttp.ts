import * as grafana from "@distilled.cloud/aws/grafana";
import * as Layer from "effect/Layer";
import { makeGrafanaWorkspaceHttpBinding } from "./BindingHttp.ts";
import { DescribeWorkspaceAuthentication } from "./DescribeWorkspaceAuthentication.ts";

export const DescribeWorkspaceAuthenticationHttp = Layer.effect(
  DescribeWorkspaceAuthentication,
  makeGrafanaWorkspaceHttpBinding({
    tag: "AWS.Grafana.DescribeWorkspaceAuthentication",
    operation: grafana.describeWorkspaceAuthentication,
    actions: ["grafana:DescribeWorkspaceAuthentication"],
  }),
);
