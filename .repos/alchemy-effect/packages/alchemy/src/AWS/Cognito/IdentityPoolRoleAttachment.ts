import * as ci from "@distilled.cloud/aws/cognito-identity";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface IdentityPoolRoleAttachmentProps {
  /**
   * The ID of the identity pool. Changing this triggers a replacement.
   */
  identityPoolId: string;
  /**
   * The IAM role ARNs vended for authenticated and unauthenticated
   * identities. The roles must trust `cognito-identity.amazonaws.com` via
   * `sts:AssumeRoleWithWebIdentity`.
   */
  roles: {
    /** Role assumed by authenticated identities. */
    authenticated?: string;
    /** Role assumed by unauthenticated (guest) identities. */
    unauthenticated?: string;
  };
}

export interface IdentityPoolRoleAttachment extends Resource<
  "AWS.Cognito.IdentityPoolRoleAttachment",
  IdentityPoolRoleAttachmentProps,
  {
    /** The ID of the identity pool the roles are attached to. */
    identityPoolId: string;
    /** The attached role ARNs by identity type. */
    roles: { authenticated?: string; unauthenticated?: string };
  },
  never,
  Providers
> {}

/**
 * Attaches the authenticated/unauthenticated IAM roles to an Amazon Cognito
 * identity pool. A singleton child of the pool — one attachment manages the
 * pool's role configuration.
 * @resource
 * @section Attaching Roles
 * @example Authenticated Role
 * ```typescript
 * import * as Cognito from "alchemy/AWS/Cognito";
 *
 * const identities = yield* Cognito.IdentityPool("Identities", {});
 * const role = yield* IAM.Role("AuthenticatedRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Federated: "cognito-identity.amazonaws.com" },
 *         Action: "sts:AssumeRoleWithWebIdentity",
 *         Condition: {
 *           StringEquals: {
 *             "cognito-identity.amazonaws.com:aud": identities.identityPoolId,
 *           },
 *         },
 *       },
 *     ],
 *   },
 * });
 * yield* Cognito.IdentityPoolRoleAttachment("Roles", {
 *   identityPoolId: identities.identityPoolId,
 *   roles: { authenticated: role.roleArn },
 * });
 * ```
 */
export const IdentityPoolRoleAttachment = Resource<IdentityPoolRoleAttachment>(
  "AWS.Cognito.IdentityPoolRoleAttachment",
);

/**
 * Bounded retry over IAM eventual consistency: a freshly-created role's
 * trust policy can take a few seconds to become visible to Cognito, which
 * rejects the attachment with InvalidParameterException ("Cannot assume
 * role"). Explicitly typed so `Retry.Return` never leaks into declaration
 * emit.
 */
const retryThroughIamPropagation = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidParameterException" ||
      e._tag === "ConcurrentModificationException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

const desiredRoles = (props: IdentityPoolRoleAttachmentProps) => {
  const roles: Record<string, string> = {};
  if (props.roles.authenticated !== undefined) {
    roles.authenticated = props.roles.authenticated;
  }
  if (props.roles.unauthenticated !== undefined) {
    roles.unauthenticated = props.roles.unauthenticated;
  }
  return roles;
};

export const IdentityPoolRoleAttachmentProvider = () =>
  Provider.effect(
    IdentityPoolRoleAttachment,
    Effect.gen(function* () {
      const getRoles = Effect.fn(function* (identityPoolId: string) {
        return yield* ci
          .getIdentityPoolRoles({ IdentityPoolId: identityPoolId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return IdentityPoolRoleAttachment.Provider.of({
        stables: ["identityPoolId"],

        // Sub-resource keyed entirely by its identity pool (identityPoolId) with no global
        // enumeration API of its own — nuke reaches it through the parent's
        // deletion, so enumeration returns empty per the ProviderService
        // doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const identityPoolId = output?.identityPoolId ?? olds?.identityPoolId;
          if (identityPoolId === undefined) return undefined;
          const observed = yield* getRoles(identityPoolId);
          const roles = observed?.Roles ?? {};
          if (Object.keys(roles).length === 0) return undefined;
          return {
            identityPoolId,
            roles: {
              authenticated: roles.authenticated,
              unauthenticated: roles.unauthenticated,
            },
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds?.identityPoolId !== news?.identityPoolId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const identityPoolId = news.identityPoolId;
          const desired = desiredRoles(news);

          // 1. OBSERVE — the attachment is a singleton child; observed state
          //    is the pool's current role map.
          const observed = yield* getRoles(identityPoolId);
          const observedRoles = Object.fromEntries(
            Object.entries(observed?.Roles ?? {}).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          );

          // 2/3. ENSURE + SYNC — SetIdentityPoolRoles is a full PUT; skip it
          //      when the observed map already matches.
          const same =
            JSON.stringify(
              Object.entries(observedRoles).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ) ===
            JSON.stringify(
              Object.entries(desired).sort(([a], [b]) => a.localeCompare(b)),
            );
          if (!same) {
            yield* retryThroughIamPropagation(
              ci.setIdentityPoolRoles({
                IdentityPoolId: identityPoolId,
                Roles: desired,
              }),
            );
          }

          yield* session.note(identityPoolId);
          return { identityPoolId, roles: news.roles };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Clearing the role map is the closest analogue to deletion for
          // this singleton child; the pool itself is unaffected.
          yield* ci
            .setIdentityPoolRoles({
              IdentityPoolId: output.identityPoolId,
              Roles: {},
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
