import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface AuthPolicyProps {
  /**
   * The ID or ARN of the service network or service the auth policy applies
   * to. Immutable — changing it replaces the resource.
   */
  resourceIdentifier: string;
  /**
   * The IAM auth policy controlling access to the service network or service,
   * either as a structured {@link PolicyDocument} or a raw JSON string
   * (escape hatch).
   */
  policy: PolicyDocument | string;
}

export interface AuthPolicy extends Resource<
  "AWS.VpcLattice.AuthPolicy",
  AuthPolicyProps,
  {
    /**
     * ID or ARN of the service network or service the policy is attached to.
     */
    resourceIdentifier: string;
    /**
     * The attached policy document as a JSON string.
     */
    policy: string;
    /**
     * Policy state reported by the API (`Active` or `Inactive` — `Inactive`
     * when the target's `authType` is `NONE`).
     */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An auth policy for a VPC Lattice service network or service — the IAM
 * resource policy evaluated on every request when the target's `authType`
 * is `AWS_IAM`.
 *
 * @resource
 * @section Attaching Auth Policies
 * @example Allow Authenticated Invoke on a Service Network
 * ```typescript
 * const network = yield* ServiceNetwork("SecureNetwork", {
 *   authType: "AWS_IAM",
 * });
 * const authPolicy = yield* AuthPolicy("NetworkAuthPolicy", {
 *   resourceIdentifier: network.serviceNetworkId,
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "*" },
 *         Action: ["vpc-lattice-svcs:Invoke"],
 *         Resource: "*",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @example Raw JSON Escape Hatch
 * ```typescript
 * const authPolicy = yield* AuthPolicy("ServiceAuthPolicy", {
 *   resourceIdentifier: service.serviceId,
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [{ Effect: "Allow", Principal: "*", Action: "vpc-lattice-svcs:Invoke", Resource: "*" }],
 *   }),
 * });
 * ```
 */
export const AuthPolicy = Resource<AuthPolicy>("AWS.VpcLattice.AuthPolicy");

export const AuthPolicyProvider = () =>
  Provider.effect(
    AuthPolicy,
    Effect.gen(function* () {
      // A missing parent and a parent without an auth policy are both
      // "no policy" — getAuthPolicy answers with an empty body for the
      // latter, so treat an absent `policy` as non-existence.
      const observe = (resourceIdentifier: string) =>
        vpclattice.getAuthPolicy({ resourceIdentifier }).pipe(
          Effect.map((response) =>
            response.policy === undefined ? undefined : response,
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const toDesired = (policy: PolicyDocument | string) =>
        typeof policy === "string" ? policy : stringifyPolicyDocument(policy);

      return {
        stables: ["resourceIdentifier"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds && olds.resourceIdentifier !== news.resourceIdentifier) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const resourceIdentifier =
            output?.resourceIdentifier ?? olds?.resourceIdentifier;
          if (!resourceIdentifier) return undefined;
          const observed = yield* observe(resourceIdentifier);
          if (!observed?.policy) return undefined;
          return {
            resourceIdentifier,
            policy: observed.policy,
            state: observed.state,
          };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const resourceIdentifier = news.resourceIdentifier;
          const desired = toDesired(news.policy);

          // Observe — putAuthPolicy is an upsert. Compare the canonicalized
          // live document against the canonicalized desired one so a
          // re-deploy of an equivalent policy (key order, whitespace) skips
          // the API call entirely.
          const observed = yield* observe(resourceIdentifier);
          let state = observed?.state;
          if (
            observed?.policy === undefined ||
            normalizePolicyDocument(observed.policy) !==
              normalizePolicyDocument(desired)
          ) {
            const put = yield* vpclattice.putAuthPolicy({
              resourceIdentifier,
              policy: desired,
            });
            state = put.state;
          }

          yield* session.note(resourceIdentifier);
          return { resourceIdentifier, policy: desired, state };
        }),
        // Auth policies are sub-resources keyed entirely by their parent
        // service network / service — there is no enumeration API.
        list: () => Effect.succeed([] as AuthPolicy["Attributes"][]),
        delete: Effect.fn(function* ({ output }) {
          yield* vpclattice
            .deleteAuthPolicy({
              resourceIdentifier: output.resourceIdentifier,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
