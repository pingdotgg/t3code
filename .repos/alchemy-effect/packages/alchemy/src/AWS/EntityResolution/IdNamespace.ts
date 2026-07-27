import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  retryRolePropagation,
  syncEntityResolutionTags,
  toTagRecord,
} from "./internal.ts";

export interface IdNamespaceProps {
  /**
   * Name of the ID namespace. Must be unique per account/region and match
   * `[a-zA-Z_0-9-]*`. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing the name replaces the ID namespace.
   */
  idNamespaceName?: string;
  /**
   * A description of the ID namespace.
   */
  description?: string;
  /**
   * The kind of data this namespace holds: `SOURCE` namespaces contain the
   * records to be mapped, `TARGET` namespaces contain the dataset (and, for
   * rule-based mapping, the matching rules) the sources are mapped onto.
   * Changing the type replaces the ID namespace.
   */
  type: entityresolution.IdNamespaceType;
  /**
   * The input records of the namespace: each entry names a Glue table
   * (`inputSourceARN`) and optionally the schema mapping (`schemaName`) that
   * describes its columns.
   */
  inputSourceConfig?: entityresolution.IdNamespaceInputSource[];
  /**
   * How this namespace participates in ID mapping workflows: `RULE_BASED`
   * with `ruleBasedProperties` (rules live on the `TARGET` namespace) or a
   * `PROVIDER` service.
   */
  idMappingWorkflowProperties?: entityresolution.IdNamespaceIdMappingWorkflowProperties[];
  /**
   * The ARN of the IAM role Entity Resolution assumes to read the namespace's
   * input Glue tables on your behalf. Required when `inputSourceConfig`
   * references Glue tables.
   */
  roleArn?: string;
  /**
   * Tags to apply to the ID namespace. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface IdNamespace extends Resource<
  "AWS.EntityResolution.IdNamespace",
  IdNamespaceProps,
  {
    /**
     * The name of the ID namespace.
     */
    idNamespaceName: string;
    /**
     * The ARN of the ID namespace.
     */
    idNamespaceArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Entity Resolution ID namespace — a wrapper around an input dataset
 * used by ID mapping workflows. A `SOURCE` namespace holds the records to be
 * translated; a `TARGET` namespace holds the dataset (and the rule-based
 * matching configuration) they are mapped onto.
 *
 * @resource
 * @section Creating ID Namespaces
 * @example Source namespace over a Glue table
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const source = yield* AWS.EntityResolution.IdNamespace("Source", {
 *   type: "SOURCE",
 *   inputSourceConfig: [
 *     { inputSourceARN: table.tableArn, schemaName: schema.schemaName },
 *   ],
 *   idMappingWorkflowProperties: [{ idMappingType: "RULE_BASED" }],
 *   roleArn: role.roleArn,
 * });
 * ```
 *
 * @example Target namespace with matching rules
 * ```typescript
 * const target = yield* AWS.EntityResolution.IdNamespace("Target", {
 *   type: "TARGET",
 *   inputSourceConfig: [
 *     { inputSourceARN: table.tableArn, schemaName: schema.schemaName },
 *   ],
 *   idMappingWorkflowProperties: [
 *     {
 *       idMappingType: "RULE_BASED",
 *       ruleBasedProperties: {
 *         rules: [{ ruleName: "ByEmail", matchingKeys: ["email"] }],
 *         ruleDefinitionTypes: ["TARGET"],
 *         attributeMatchingModel: "ONE_TO_ONE",
 *         recordMatchingModels: ["ONE_SOURCE_TO_ONE_TARGET"],
 *       },
 *     },
 *   ],
 *   roleArn: role.roleArn,
 * });
 * ```
 */
export const IdNamespace = Resource<IdNamespace>(
  "AWS.EntityResolution.IdNamespace",
);

export const IdNamespaceProvider = () =>
  Provider.effect(
    IdNamespace,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { idNamespaceName?: string | undefined },
      ) {
        return (
          props.idNamespaceName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      /** Get an ID namespace by name; typed not-found → undefined. */
      const getByName = Effect.fn(function* (idNamespaceName: string) {
        return yield* entityresolution
          .getIdNamespace({ idNamespaceName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["idNamespaceName", "idNamespaceArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.idNamespaceName ?? (yield* createName(id, olds ?? {}));
          const namespace = yield* getByName(name);
          if (namespace === undefined) return undefined;
          const attrs = {
            idNamespaceName: namespace.idNamespaceName,
            idNamespaceArn: namespace.idNamespaceArn,
          };
          // getIdNamespace returns tags — use the observed tags for the
          // ownership check.
          const tags = toTagRecord(namespace.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          // The name is the identity, and `type` is create-only —
          // updateIdNamespace does not accept it.
          if (oldName !== newName || olds.type !== news.type) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.idNamespaceName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — names are unique, so the name IS the identity.
          let namespace = yield* getByName(name);

          // 2. Ensure — create when missing. A freshly-created IAM role is
          //    transiently rejected while IAM propagates; tolerate the
          //    concurrent-create race, then re-observe.
          if (namespace === undefined) {
            yield* entityresolution
              .createIdNamespace({
                idNamespaceName: name,
                description: news.description,
                type: news.type,
                inputSourceConfig: news.inputSourceConfig,
                idMappingWorkflowProperties: news.idMappingWorkflowProperties,
                roleArn: news.roleArn,
                tags: desiredTags,
              })
              .pipe(
                retryRolePropagation,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            namespace = yield* entityresolution.getIdNamespace({
              idNamespaceName: name,
            });
          }

          // 3. Sync — everything except name/type updates in place via a
          //    full-PUT update. Only call the API on an actual delta between
          //    OBSERVED and desired configuration.
          const desired = {
            description: news.description ?? undefined,
            inputSourceConfig: news.inputSourceConfig ?? undefined,
            idMappingWorkflowProperties:
              news.idMappingWorkflowProperties ?? undefined,
            roleArn: news.roleArn ?? undefined,
          };
          const observed = {
            description: namespace.description ?? undefined,
            inputSourceConfig: namespace.inputSourceConfig ?? undefined,
            idMappingWorkflowProperties:
              namespace.idMappingWorkflowProperties ?? undefined,
            roleArn: namespace.roleArn ?? undefined,
          };
          if (!deepEqual(observed, desired)) {
            yield* entityresolution
              .updateIdNamespace({
                idNamespaceName: name,
                description: news.description,
                inputSourceConfig: news.inputSourceConfig,
                idMappingWorkflowProperties: news.idMappingWorkflowProperties,
                roleArn: news.roleArn,
              })
              .pipe(retryRolePropagation);
          }

          const idNamespaceArn = namespace.idNamespaceArn;

          // 3b. Sync tags against OBSERVED cloud tags (adoption-safe).
          yield* syncEntityResolutionTags(idNamespaceArn, desiredTags);

          yield* session.note(idNamespaceArn);
          return { idNamespaceName: name, idNamespaceArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteIdNamespace succeeds even when the namespace is already
          // gone; it conflicts while an ID mapping workflow still references
          // it (the engine deletes dependents first — retry the
          // eventual-consistency window).
          yield* entityresolution
            .deleteIdNamespace({ idNamespaceName: output.idNamespaceName })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
            );
        }),

        list: () =>
          entityresolution.listIdNamespaces.items({}).pipe(
            Stream.map((summary) => ({
              idNamespaceName: summary.idNamespaceName,
              idNamespaceArn: summary.idNamespaceArn,
            })),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );
