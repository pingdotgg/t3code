import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Layer from "effect/Layer";
import { makeRuleSetHttpBinding } from "./BindingHttp.ts";
import { GetRuleSet } from "./GetRuleSet.ts";

/**
 * HTTP implementation of {@link GetRuleSet}.
 *
 * Grants `roles/contentwarehouse.admin` on the project because
 * `contentwarehouse.ruleSets.get` is in no narrower predefined role.
 *
 * @layer
 * @provides GCP.ContentWarehouse.GetRuleSet
 */
export const GetRuleSetHttp = Layer.effect(
  GetRuleSet,
  makeRuleSetHttpBinding({
    tag: "GCP.ContentWarehouse.GetRuleSet",
    operation: cw.getProjectsLocationsRuleSets,
    // contentwarehouse.ruleSets.get is only in contentwarehouse.admin.
    iam: { role: "roles/contentwarehouse.admin" },
  }),
);
