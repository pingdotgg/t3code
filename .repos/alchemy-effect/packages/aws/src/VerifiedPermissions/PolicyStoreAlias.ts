import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export class PolicyStoreAliasUnexpectedResponse extends Data.TaggedError(
  "PolicyStoreAliasUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface PolicyStoreAliasProps {
  /**
   * The ID of the policy store the alias points at. There is no update API
   * for aliases — changing the store replaces the alias.
   */
  policyStoreId: string;
  /**
   * Name of the alias. AWS requires every alias name to start with
   * `policy-store-alias/`; the prefix is added automatically when omitted,
   * so `"photo-app-prod"` and `"policy-store-alias/photo-app-prod"` name the
   * same alias. The full name may be at most 150 characters of letters,
   * digits, `-`, `_`, and `/`, and must be unique per account and region.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing the name replaces the alias.
   */
  aliasName?: string;
  /**
   * How the alias is deleted when the resource is destroyed. `SoftDelete`
   * keeps the alias name reserved in `PendingDeletion` state for a recovery
   * window; `HardDelete` frees the name immediately.
   * @default "HardDelete"
   */
  deletionMode?: "SoftDelete" | "HardDelete";
}

export interface PolicyStoreAlias extends Resource<
  "AWS.VerifiedPermissions.PolicyStoreAlias",
  PolicyStoreAliasProps,
  {
    /**
     * Full name of the alias, including the `policy-store-alias/` prefix —
     * usable in place of a policy store ID in authorization requests.
     */
    aliasName: string;
    /**
     * ID of the policy store the alias points at.
     */
    policyStoreId: string;
    /**
     * ARN of the alias.
     */
    aliasArn: string;
  },
  {},
  Providers
> {}

/**
 * A named alias for a Verified Permissions policy store. Aliases let callers
 * reference a policy store by a stable name (e.g. in `IsAuthorized`
 * requests) so the underlying store can be swapped without reconfiguring
 * clients. Alias names always carry the `policy-store-alias/` prefix AWS
 * requires; it is added automatically to generated and user-supplied names.
 *
 * ### Creating an Alias
 * **Example:** Alias with a Generated Name
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 *
 * const store = yield* AWS.VerifiedPermissions.PolicyStore("Store", {});
 *
 * const alias = yield* AWS.VerifiedPermissions.PolicyStoreAlias("Alias", {
 *   policyStoreId: store.policyStoreId,
 * });
 * ```
 *
 * **Example:** Named Alias with Hard Delete
 * ```typescript
 * yield* AWS.VerifiedPermissions.PolicyStoreAlias("Alias", {
 *   policyStoreId: store.policyStoreId,
 *   // created as "policy-store-alias/photo-app-prod"
 *   aliasName: "photo-app-prod",
 *   deletionMode: "HardDelete",
 * });
 * ```
 *
 * @resource
 */
export const PolicyStoreAlias = Resource<PolicyStoreAlias>(
  "AWS.VerifiedPermissions.PolicyStoreAlias",
);

/**
 * Every alias name must carry this prefix — CreatePolicyStoreAlias,
 * GetPolicyStoreAlias, and DeletePolicyStoreAlias reject bare names with a
 * ValidationException.
 */
const ALIAS_PREFIX = "policy-store-alias/";

/** Smithy `Alias` shape: max length of the full (prefixed) name. */
const ALIAS_MAX_LENGTH = 150;

const withAliasPrefix = (aliasName: string) =>
  aliasName.startsWith(ALIAS_PREFIX) ? aliasName : `${ALIAS_PREFIX}${aliasName}`;

const toAliasName = (id: string, props: { aliasName?: string } = {}) =>
  props.aliasName
    ? Effect.succeed(withAliasPrefix(props.aliasName))
    : createPhysicalName({
        id,
        maxLength: ALIAS_MAX_LENGTH - ALIAS_PREFIX.length,
        lowercase: true,
      }).pipe(Effect.map((name) => `${ALIAS_PREFIX}${name}`));

export const PolicyStoreAliasProvider = () =>
  Provider.effect(
    PolicyStoreAlias,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (aliasName: string) {
        return yield* avp
          .getPolicyStoreAlias({ aliasName })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
      });

      return PolicyStoreAlias.Provider.of({
        stables: ["aliasName", "policyStoreId", "aliasArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* avp.listPolicyStoreAliases.pages({}).pipe(Stream.runCollect);
            const items = Array.from(pages).flatMap((page) => page.policyStoreAliases ?? []);
            return items.map((item) => ({
              aliasName: item.aliasName,
              policyStoreId: item.policyStoreId,
              aliasArn: item.aliasArn,
            }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const aliasName =
            output?.aliasName ?? (olds !== undefined ? yield* toAliasName(id, olds) : undefined);
          if (aliasName === undefined) return undefined;
          const alias = yield* observe(aliasName);
          if (alias === undefined || alias.state === "PendingDeletion") {
            return undefined;
          }
          return {
            aliasName: alias.aliasName,
            policyStoreId: alias.policyStoreId,
            aliasArn: alias.aliasArn,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // no UpdatePolicyStoreAlias API — name and target changes replace;
          // deletionMode only affects delete-time behavior
          if (
            olds.policyStoreId !== news.policyStoreId ||
            (news.aliasName !== undefined &&
              (olds.aliasName === undefined ||
                withAliasPrefix(olds.aliasName) !== withAliasPrefix(news.aliasName)))
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const aliasName = output?.aliasName ?? (yield* toAliasName(id, news));

          // 1. OBSERVE — cloud state is authoritative
          const existing = yield* observe(aliasName);

          // 2. ENSURE — tolerate the AlreadyExists race
          if (existing === undefined || existing.state === "PendingDeletion") {
            const created = yield* avp
              .createPolicyStoreAlias({
                aliasName,
                policyStoreId: news.policyStoreId,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.undefined));
            if (created !== undefined) {
              yield* session.note(created.aliasName);
              return {
                aliasName: created.aliasName,
                policyStoreId: created.policyStoreId,
                aliasArn: created.aliasArn,
              };
            }
          }

          const alias = existing ?? (yield* observe(aliasName));
          if (alias === undefined) {
            return yield* new PolicyStoreAliasUnexpectedResponse({
              message: `policy store alias '${aliasName}' not found after create`,
            });
          }
          yield* session.note(alias.aliasName);
          return {
            aliasName: alias.aliasName,
            policyStoreId: alias.policyStoreId,
            aliasArn: alias.aliasArn,
          };
        }),

        delete: Effect.fn(function* ({ olds, output }) {
          yield* avp
            .deletePolicyStoreAlias({
              aliasName: output.aliasName,
              deletionMode: olds.deletionMode ?? "HardDelete",
            })
            .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
        }),
      });
    }),
  );
