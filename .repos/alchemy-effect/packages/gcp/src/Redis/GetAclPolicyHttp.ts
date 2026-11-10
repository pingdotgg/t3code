import * as redis from "@distilled.cloud/gcp/redis_v1";
import * as Layer from "effect/Layer";
import { makeRedisHttpBinding } from "./BindingHttp.ts";
import { GetAclPolicy } from "./GetAclPolicy.ts";

/**
 * HTTP implementation of {@link GetAclPolicy}.
 *
 * @layer
 * @provides GCP.Redis.GetAclPolicy
 */
export const GetAclPolicyHttp = Layer.effect(
  GetAclPolicy,
  makeRedisHttpBinding({
    tag: "GCP.Redis.GetAclPolicy",
    operation: redis.getProjectsLocationsAclPolicies,
  }),
);
