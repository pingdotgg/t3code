import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * Identifies a Cedar entity, e.g.
 * `{ entityType: "PhotoApp::User", entityId: "alice" }`.
 */
export interface EntityIdentifier {
  /** The Cedar entity type, e.g. `PhotoApp::User`. */
  entityType: string;
  /** The entity ID, e.g. `alice`. */
  entityId: string;
}

export interface PolicyProps {
  /**
   * The ID of the policy store the policy belongs to. Changing the store
   * replaces the policy.
   */
  policyStoreId: string;
  /**
   * The Cedar policy statement for a **static** policy, e.g.
   * `permit(principal, action == Action::"view", resource);`. Mutable —
   * updating re-submits the statement via `UpdatePolicy` (only annotations
   * and conditions may change; the principal/resource scope is fixed).
   *
   * Exactly one of `statement` (static) or `templateId` (template-linked)
   * must be provided.
   */
  statement?: string;
  /**
   * An optional description stored alongside a static policy statement.
   */
  description?: string;
  /**
   * The ID of a {@link PolicyTemplate} to instantiate as a
   * **template-linked** policy. Template-linked policies cannot be updated
   * in place — changing `templateId`, `principal`, or `resource` replaces
   * the policy (the template itself is the mutable part).
   */
  templateId?: string;
  /**
   * The principal to fill into the template's `?principal` placeholder.
   * Only valid with `templateId`.
   */
  principal?: EntityIdentifier;
  /**
   * The resource to fill into the template's `?resource` placeholder.
   * Only valid with `templateId`.
   */
  resource?: EntityIdentifier;
}

export interface Policy extends Resource<
  "AWS.VerifiedPermissions.Policy",
  PolicyProps,
  {
    /**
     * ID of the policy store the policy belongs to.
     */
    policyStoreId: string;
    /**
     * Service-assigned unique ID of the policy within the store.
     */
    policyId: string;
  },
  {},
  Providers
> {}

/**
 * A static Cedar policy in a Verified Permissions policy store. Static
 * policies contain a complete Cedar statement and are evaluated for every
 * matching authorization request.
 * @resource
 * @section Creating Policies
 * @example Permit a Specific Principal
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const store = yield* AWS.VerifiedPermissions.PolicyStore("Store", {});
 *
 * yield* AWS.VerifiedPermissions.Policy("AllowAlice", {
 *   policyStoreId: store.policyStoreId,
 *   statement: `permit(
 *     principal == PhotoApp::User::"alice",
 *     action == PhotoApp::Action::"viewPhoto",
 *     resource
 *   );`,
 *   description: "Alice can view any photo",
 * });
 * ```
 *
 * @section Template-Linked Policies
 * @example Instantiate a Policy Template for a Principal
 * ```typescript
 * const template = yield* AWS.VerifiedPermissions.PolicyTemplate("ViewPhoto", {
 *   policyStoreId: store.policyStoreId,
 *   statement: `permit(
 *     principal == ?principal,
 *     action == PhotoApp::Action::"viewPhoto",
 *     resource
 *   );`,
 * });
 *
 * yield* AWS.VerifiedPermissions.Policy("AliceCanView", {
 *   policyStoreId: store.policyStoreId,
 *   templateId: template.policyTemplateId,
 *   principal: { entityType: "PhotoApp::User", entityId: "alice" },
 * });
 * ```
 */
export const Policy = Resource<Policy>("AWS.VerifiedPermissions.Policy");

/** Desired props → the wire `PolicyDefinition` union. */
const toDefinition = (news: PolicyProps) =>
  Effect.gen(function* () {
    if (news.templateId !== undefined && news.statement !== undefined) {
      return yield* Effect.fail(
        new Error(
          "a Policy accepts either `statement` (static) or `templateId` (template-linked), not both",
        ),
      );
    }
    if (news.templateId !== undefined) {
      return {
        templateLinked: {
          policyTemplateId: news.templateId,
          principal: news.principal,
          resource: news.resource,
        },
      } as const;
    }
    if (news.statement === undefined) {
      return yield* Effect.fail(
        new Error(
          "a Policy requires either `statement` (static) or `templateId` (template-linked)",
        ),
      );
    }
    return {
      static: { statement: news.statement, description: news.description },
    } as const;
  });

export const PolicyProvider = () =>
  Provider.effect(
    Policy,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (
        policyStoreId: string,
        policyId: string,
      ) {
        return yield* avp
          .getPolicy({ policyStoreId, policyId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Policy.Provider.of({
        stables: ["policyStoreId", "policyId"],

        // child of a policy store — not enumerable account-wide
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const policyStoreId = output?.policyStoreId ?? olds?.policyStoreId;
          const policyId = output?.policyId;
          if (policyStoreId === undefined || policyId === undefined) {
            return undefined;
          }
          const policy = yield* observe(policyStoreId, policyId);
          if (policy === undefined) return undefined;
          return { policyStoreId, policyId: policy.policyId };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.policyStoreId !== news.policyStoreId) {
            return { action: "replace" } as const;
          }
          // switching static <-> template-linked replaces; UpdatePolicy only
          // supports static definitions, and a template-linked policy's
          // template/principal/resource are fixed at creation
          if (
            (olds.templateId === undefined) !==
              (news.templateId === undefined) ||
            (news.templateId !== undefined &&
              (olds.templateId !== news.templateId ||
                olds.principal?.entityType !== news.principal?.entityType ||
                olds.principal?.entityId !== news.principal?.entityId ||
                olds.resource?.entityType !== news.resource?.entityType ||
                olds.resource?.entityId !== news.resource?.entityId))
          ) {
            return { action: "replace" } as const;
          }
          // static statement / description are mutable → default update path
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const definition = yield* toDefinition(news);

          // 1. OBSERVE — cloud state is authoritative
          const existing =
            output?.policyId !== undefined
              ? yield* observe(news.policyStoreId, output.policyId)
              : undefined;

          // 2. ENSURE / SYNC
          let policyId: string;
          if (existing === undefined) {
            const created = yield* avp.createPolicy({
              policyStoreId: news.policyStoreId,
              definition,
            });
            policyId = created.policyId;
          } else if (
            "static" in definition &&
            definition.static !== undefined
          ) {
            const updated = yield* avp.updatePolicy({
              policyStoreId: news.policyStoreId,
              policyId: existing.policyId,
              definition: { static: definition.static },
            });
            policyId = updated.policyId;
          } else {
            // template-linked policies have no in-place update — diff replaces
            // on any change, so the observed policy is already converged
            policyId = existing.policyId;
          }

          yield* session.note(policyId);
          return { policyStoreId: news.policyStoreId, policyId };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* avp
            .deletePolicy({
              policyStoreId: output.policyStoreId,
              policyId: output.policyId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
