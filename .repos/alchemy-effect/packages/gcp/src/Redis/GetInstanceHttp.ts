import * as redis from "@distilled.cloud/gcp/redis_v1";
import * as Layer from "effect/Layer";
import { makeRedisInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Redis.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeRedisInstanceHttpBinding({
    tag: "GCP.Redis.GetInstance",
    operation: redis.getProjectsLocationsInstances,
    iam: { role: "roles/redis.viewer", scopeByCondition: true },
  }),
);
