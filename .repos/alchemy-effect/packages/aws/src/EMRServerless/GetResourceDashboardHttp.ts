import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { GetResourceDashboard } from "./GetResourceDashboard.ts";

export const GetResourceDashboardHttp = Layer.effect(
  GetResourceDashboard,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.GetResourceDashboard",
    operation: emr.getResourceDashboard,
    actions: ["emr-serverless:GetResourceDashboard"],
    // The dashboard is minted for a sub-resource (e.g. a session) of the
    // application — grant the sub-resource wildcard alongside the
    // application ARN. NOTE: as of 2026-07 the service denies this action
    // for every caller (even `Action:"*"` admins) — see
    // test/AWS/EMRServerless/probe.test.ts, which pins that platform gate.
    subresources: ["/*"],
  }),
);
