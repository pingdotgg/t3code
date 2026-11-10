import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Layer from "effect/Layer";
import { makeSpannerInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Spanner.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeSpannerInstanceHttpBinding({
    tag: "GCP.Spanner.GetInstance",
    iam: { role: "roles/spanner.viewer", on: "spanner.instance" },
    operation: spanner.getProjectsInstances,
  }),
);
