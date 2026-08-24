import * as schemas from "@distilled.cloud/aws/schemas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
  type PolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import { syncSchemasTags } from "./internal.ts";

export interface RegistryProps {
  /**
   * Name of the registry. Must match `[a-zA-Z0-9-_.@]+` and be at most 64
   * characters. If omitted, a unique name is generated. Changing it replaces
   * the registry.
   */
  registryName?: string;

  /**
   * A description of the registry.
   */
  description?: string;

  /**
   * User tags to attach to the registry.
   */
  tags?: Record<string, string>;

  /**
   * Resource-based policy attached to the registry, granting other AWS
   * accounts or principals access to the registry and its schemas. Provided
   * as a structured {@link PolicyDocument} or a raw JSON string. Omitting it
   * removes any existing resource policy.
   */
  policy?: PolicyDocument | string;
}

export interface Registry extends Resource<
  "AWS.Schemas.Registry",
  RegistryProps,
  {
    /** The name of the registry. */
    registryName: string;
    /** The ARN of the registry. */
    registryArn: string;
  },
  never,
  Providers
> {}

/**
 * An EventBridge Schema Registry — a named collection of event schemas.
 * Custom registries hold your own OpenAPI 3 / JSONSchema Draft 4 schema
 * documents; AWS also maintains the built-in `aws.events` and
 * `discovered-schemas` registries.
 *
 * @resource
 * @section Creating a Registry
 * @example Basic Registry
 * ```typescript
 * const registry = yield* AWS.Schemas.Registry("app-events", {
 *   description: "Schemas for application events",
 * });
 * ```
 *
 * @example Registry with Tags
 * ```typescript
 * const registry = yield* AWS.Schemas.Registry("orders", {
 *   description: "Order lifecycle events",
 *   tags: { team: "payments" },
 * });
 * ```
 *
 * @section Sharing a Registry
 * @example Registry with a Resource Policy
 * ```typescript
 * const registry = yield* AWS.Schemas.Registry("shared-events", {
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: `arn:aws:iam::${otherAccountId}:root` },
 *         Action: ["schemas:DescribeRegistry", "schemas:SearchSchemas"],
 *         Resource: registryArn,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @section Adding Schemas
 * @example Registry with a Schema
 * ```typescript
 * const registry = yield* AWS.Schemas.Registry("app-events", {});
 * const schema = yield* AWS.Schemas.Schema("OrderCreated", {
 *   registryName: registry.registryName,
 *   type: "OpenApi3",
 *   content: JSON.stringify(openApiDocument),
 * });
 * ```
 */
export const Registry = Resource<Registry>("AWS.Schemas.Registry");

export const RegistryProvider = () =>
  Provider.effect(
    Registry,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: RegistryProps,
      ) {
        return (
          props.registryName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const describe = (registryName: string) =>
        schemas
          .describeRegistry({ RegistryName: registryName })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      return Registry.Provider.of({
        stables: ["registryName", "registryArn"],

        // Top-level, account/region-scoped: enumerate every customer-owned
        // registry. Scope LOCAL excludes the AWS-managed registries
        // (aws.events, discovered-schemas).
        list: () =>
          schemas.listRegistries.pages({ Scope: "LOCAL" }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Registries ?? [])
                  .filter(
                    (r) => r.RegistryName != null && r.RegistryArn != null,
                  )
                  .map((r) => ({
                    registryName: r.RegistryName!,
                    registryArn: r.RegistryArn!,
                  })),
              ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const registryName =
            output?.registryName ?? (yield* createName(id, olds ?? {}));
          const found = yield* describe(registryName);
          if (!found) return undefined;
          const attrs = {
            registryName,
            registryArn: found.RegistryArn!,
          };
          return (yield* hasAlchemyTags(id, found.Tags))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const registryName =
            output?.registryName ?? (yield* createName(id, news));

          // OBSERVE
          let live = yield* describe(registryName);

          // ENSURE — tolerate the create race as "already exists".
          if (live === undefined) {
            yield* schemas
              .createRegistry({
                RegistryName: registryName,
                Description: news.description,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            live = yield* schemas.describeRegistry({
              RegistryName: registryName,
            });
          }

          // SYNC description — diff observed against desired.
          if ((news.description ?? "") !== (live.Description ?? "")) {
            yield* schemas.updateRegistry({
              RegistryName: registryName,
              Description: news.description ?? "",
            });
          }

          // SYNC resource policy — diff observed against desired, comparing
          // canonicalized documents so a re-deploy of an equivalent policy
          // (key order, whitespace) is a no-op.
          const desiredPolicy =
            news.policy === undefined
              ? undefined
              : typeof news.policy === "string"
                ? news.policy
                : stringifyPolicyDocument(news.policy);
          const currentPolicy = yield* schemas
            .getResourcePolicy({ RegistryName: registryName })
            .pipe(
              Effect.map((r) => (r.Policy ? r.Policy : undefined)),
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const policyDrifted =
            desiredPolicy === undefined || currentPolicy === undefined
              ? desiredPolicy !== currentPolicy
              : normalizePolicyDocument(currentPolicy) !==
                normalizePolicyDocument(desiredPolicy);
          if (policyDrifted) {
            if (desiredPolicy === undefined) {
              yield* schemas
                .deleteResourcePolicy({ RegistryName: registryName })
                .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
            } else {
              yield* schemas.putResourcePolicy({
                RegistryName: registryName,
                Policy: desiredPolicy,
              });
            }
          }

          // SYNC tags — diff against observed cloud tags.
          yield* syncSchemasTags(live.RegistryArn!, id, news.tags);

          yield* session.note(registryName);
          return {
            registryName,
            registryArn: live.RegistryArn!,
          };
        }),

        delete: Effect.fn(function* ({ output, force }) {
          const RegistryName = output.registryName;
          if (force !== true) {
            yield* schemas
              .deleteRegistry({ RegistryName })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
            return;
          }

          const purgeAndDelete = Effect.gen(function* () {
            // Schemas are registry-scoped and globally invisible to nuke.
            // Only its explicit operator-confirmed force path may remove them
            // or an attached registry policy.
            const childSchemas = yield* schemas.listSchemas
              .items({ RegistryName })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
              );
            yield* Effect.forEach(
              childSchemas,
              (schema) =>
                schema.SchemaName === undefined
                  ? Effect.void
                  : schemas
                      .deleteSchema({
                        RegistryName,
                        SchemaName: schema.SchemaName,
                      })
                      .pipe(
                        Effect.catchTag("NotFoundException", () => Effect.void),
                      ),
              { concurrency: 4, discard: true },
            );
            yield* schemas
              .deleteResourcePolicy({ RegistryName })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
            yield* schemas.deleteRegistry({ RegistryName });
          });

          yield* purgeAndDelete.pipe(
            // Registry deletion can briefly observe schemas that have already
            // accepted deletion. Re-list and retry only bounded transient or
            // dependency-shaped failures.
            Effect.retry({
              while: (e) =>
                e._tag === "BadRequestException" ||
                e._tag === "InternalServerErrorException" ||
                e._tag === "ServiceUnavailableException",
              schedule: Schedule.max([
                Schedule.exponential(500),
                Schedule.recurs(8),
              ]),
            }),
            Effect.catchTag("NotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
