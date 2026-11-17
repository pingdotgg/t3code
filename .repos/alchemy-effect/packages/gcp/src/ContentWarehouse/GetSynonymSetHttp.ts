import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Layer from "effect/Layer";
import { makeSynonymSetHttpBinding } from "./BindingHttp.ts";
import { GetSynonymSet } from "./GetSynonymSet.ts";

/**
 * HTTP implementation of {@link GetSynonymSet}.
 *
 * Grants `roles/contentwarehouse.admin` on the project because
 * `contentwarehouse.synonymSets.get` is in no narrower predefined role.
 *
 * @layer
 * @provides GCP.ContentWarehouse.GetSynonymSet
 */
export const GetSynonymSetHttp = Layer.effect(
  GetSynonymSet,
  makeSynonymSetHttpBinding({
    tag: "GCP.ContentWarehouse.GetSynonymSet",
    operation: cw.getProjectsLocationsSynonymSets,
    // contentwarehouse.synonymSets.get is only in contentwarehouse.admin.
    iam: { role: "roles/contentwarehouse.admin" },
  }),
);
