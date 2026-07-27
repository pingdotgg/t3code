import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Schema-validation strictness applied to Cedar policies and templates
 * submitted to the store.
 *
 * - `OFF` — no schema validation.
 * - `STRICT` — policies must reference entity types and actions declared in
 *   the store's schema (requires a schema to be present).
 */
export type ValidationMode = "OFF" | "STRICT";

export interface PolicyStoreProps {
  /**
   * The schema-validation mode for the policy store.
   * @default "OFF"
   */
  validationMode?: ValidationMode;
  /**
   * A human-readable description for the policy store.
   */
  description?: string;
  /**
   * When `ENABLED`, the store cannot be deleted until protection is disabled.
   * Leave `DISABLED` for ephemeral / test stores.
   * @default "DISABLED"
   */
  deletionProtection?: "ENABLED" | "DISABLED";
  /**
   * Tags to apply to the policy store. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface PolicyStore extends Resource<
  "AWS.VerifiedPermissions.PolicyStore",
  PolicyStoreProps,
  {
    /**
     * Service-assigned unique ID of the policy store — pass it to
     * {@link Policy}, {@link Schema}, and `IsAuthorized`.
     */
    policyStoreId: string;
    /**
     * ARN of the policy store.
     */
    policyStoreArn: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon Verified Permissions policy store — the container for Cedar
 * policies, policy templates, and a schema. Authorization requests
 * (`IsAuthorized`) are evaluated against all policies in a store.
 * @resource
 * @section Creating a Policy Store
 * @example Basic Policy Store
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const store = yield* AWS.VerifiedPermissions.PolicyStore("Store", {
 *   validationMode: "OFF",
 * });
 * ```
 *
 * @example Strict Validation with a Schema
 * ```typescript
 * const store = yield* AWS.VerifiedPermissions.PolicyStore("Store", {
 *   validationMode: "STRICT",
 *   description: "Photo app authorization",
 * });
 *
 * yield* AWS.VerifiedPermissions.Schema("Schema", {
 *   policyStoreId: store.policyStoreId,
 *   cedarJson: JSON.stringify({
 *     PhotoApp: {
 *       entityTypes: { User: {}, Photo: {} },
 *       actions: { viewPhoto: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Photo"] } } },
 *     },
 *   }),
 * });
 * ```
 */
export const PolicyStore = Resource<PolicyStore>(
  "AWS.VerifiedPermissions.PolicyStore",
);

export const PolicyStoreProvider = () =>
  Provider.effect(
    PolicyStore,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (policyStoreId: string) {
        return yield* avp
          .getPolicyStore({ policyStoreId, tags: true })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return PolicyStore.Provider.of({
        stables: ["policyStoreId", "policyStoreArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* avp.listPolicyStores
              .pages({})
              .pipe(Stream.runCollect);
            const items = Array.from(pages).flatMap(
              (page) => page.policyStores ?? [],
            );
            return items.map((item) => ({
              policyStoreId: item.policyStoreId,
              policyStoreArn: item.arn,
            }));
          }),

        read: Effect.fn(function* ({ id, output }) {
          if (output?.policyStoreId === undefined) return undefined;
          const store = yield* observe(output.policyStoreId);
          if (store === undefined) return undefined;
          const attrs = {
            policyStoreId: store.policyStoreId,
            policyStoreArn: store.arn,
          };
          const tags = (store.tags ?? {}) as Record<string, string>;
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // no props trigger replacement — validationMode / description /
        // deletionProtection are all mutable via updatePolicyStore
        diff: Effect.fn(function* ({ news }) {
          if (!isResolved(news)) return undefined;
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const validationMode = news.validationMode ?? "OFF";

          // 1. OBSERVE — cloud state is authoritative
          let store =
            output?.policyStoreId !== undefined
              ? yield* observe(output.policyStoreId)
              : undefined;

          // 2. ENSURE — createPolicyStore returns id + arn directly
          if (store === undefined) {
            const created = yield* avp.createPolicyStore({
              validationSettings: { mode: validationMode },
              description: news.description,
              deletionProtection: news.deletionProtection,
              tags: desiredTags,
            });
            store = yield* observe(created.policyStoreId);
            if (store === undefined) {
              return {
                policyStoreId: created.policyStoreId,
                policyStoreArn: created.arn,
              };
            }
          }

          // 3. SYNC — validation / description / deletion protection
          const observedMode = store.validationSettings.mode;
          // description decodes as a Redacted (SensitiveString) — unwrap to
          // compare against the desired plain-string value
          const observedDescription =
            store.description === undefined
              ? undefined
              : Redacted.isRedacted(store.description)
                ? Redacted.value(store.description)
                : store.description;
          const observedProtection = store.deletionProtection ?? "DISABLED";
          const desiredProtection = news.deletionProtection ?? "DISABLED";
          if (
            observedMode !== validationMode ||
            observedDescription !== (news.description ?? undefined) ||
            observedProtection !== desiredProtection
          ) {
            yield* avp.updatePolicyStore({
              policyStoreId: store.policyStoreId,
              validationSettings: { mode: validationMode },
              description: news.description,
              deletionProtection: news.deletionProtection,
            });
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags
          const observedTags = (store.tags ?? {}) as Record<string, string>;
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* avp.tagResource({
              resourceArn: store.arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* avp.untagResource({
              resourceArn: store.arn,
              tagKeys: removed,
            });
          }

          yield* session.note(store.policyStoreId);
          return {
            policyStoreId: store.policyStoreId,
            policyStoreArn: store.arn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deletePolicyStore is idempotent — returns 200 even if the store
          // does not exist
          yield* avp.deletePolicyStore({
            policyStoreId: output.policyStoreId,
          });
        }),
      });
    }),
  );
