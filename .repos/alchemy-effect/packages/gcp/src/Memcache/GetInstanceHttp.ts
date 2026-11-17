import * as memcache from "@distilled.cloud/gcp/memcache_v1";
import * as Layer from "effect/Layer";
import { makeMemcacheInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Memcache.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeMemcacheInstanceHttpBinding({
    tag: "GCP.Memcache.GetInstance",
    iam: { role: "roles/memcache.viewer" },
    operation: memcache.getProjectsLocationsInstances,
  }),
);
