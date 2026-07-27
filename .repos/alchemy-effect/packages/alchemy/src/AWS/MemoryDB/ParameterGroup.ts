import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readMemoryDbTags } from "./internal.ts";

export interface ParameterGroupProps {
  /**
   * Name of the parameter group. Must be 1-40 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * parameter group.
   */
  parameterGroupName?: string;
  /**
   * Parameter group family the group belongs to, e.g. `"memorydb_valkey7"`,
   * `"memorydb_valkey8"`, `"memorydb_redis7"`. Changing the family replaces
   * the parameter group.
   */
  family: string;
  /**
   * Human-readable description of the parameter group. The MemoryDB API has
   * no update for descriptions, so changing it replaces the parameter group.
   */
  description?: string;
  /**
   * Engine parameter overrides (name → value), e.g.
   * `{ "maxmemory-policy": "allkeys-lru" }`. Parameters removed from this map
   * are reset to the engine default.
   * @default {} (engine defaults)
   */
  parameters?: Record<string, string>;
  /**
   * User-defined tags for the parameter group.
   */
  tags?: Record<string, string>;
}

export interface ParameterGroup extends Resource<
  "AWS.MemoryDB.ParameterGroup",
  ParameterGroupProps,
  {
    /** Name of the parameter group. */
    parameterGroupName: string;
    /** ARN of the parameter group. */
    parameterGroupArn: string;
    /** Parameter group family (e.g. `memorydb_valkey7`). */
    family: string | undefined;
    /** Description of the parameter group. */
    description: string | undefined;
    /** Tags on the parameter group (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A MemoryDB parameter group — a named collection of engine parameter
 * overrides applied to every node of any {@link Cluster} that references it
 * via `parameterGroupName`.
 *
 * Parameter groups are free and provision instantly. Parameters not listed
 * keep their engine defaults; removing a parameter from `parameters` resets
 * it to the default.
 * @resource
 * @section Creating a Parameter Group
 * @example Parameter Group with an Eviction Policy
 * ```typescript
 * const params = yield* ParameterGroup("CacheParams", {
 *   family: "memorydb_valkey7",
 *   description: "LRU eviction for the session cache",
 *   parameters: { "maxmemory-policy": "allkeys-lru" },
 * });
 * const cluster = yield* Cluster("Cache", {
 *   aclName: acl.aclName,
 *   parameterGroupName: params.parameterGroupName,
 * });
 * ```
 */
export const ParameterGroup = Resource<ParameterGroup>(
  "AWS.MemoryDB.ParameterGroup",
);

export const ParameterGroupProvider = () =>
  Provider.effect(
    ParameterGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ParameterGroupProps>) =>
        props.parameterGroupName
          ? Effect.succeed(props.parameterGroupName)
          : createPhysicalName({ id, maxLength: 40, lowercase: true });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* memorydb
          .describeParameterGroups({ ParameterGroupName: name })
          .pipe(
            Effect.catchTag("ParameterGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ParameterGroups?.[0];
      });

      // Observed engine parameters (name → value), paginated.
      const readParameters = Effect.fn(function* (name: string) {
        const parameters = new Map<string, string>();
        yield* memorydb.describeParameters
          .pages({ ParameterGroupName: name })
          .pipe(
            Stream.runForEach((page) =>
              Effect.sync(() => {
                for (const parameter of page.Parameters ?? []) {
                  if (parameter.Name !== undefined) {
                    parameters.set(parameter.Name, parameter.Value ?? "");
                  }
                }
              }),
            ),
          );
        return parameters;
      });

      const toAttrs = Effect.fn(function* (group: memorydb.ParameterGroup) {
        if (!group.Name || !group.ARN) {
          return yield* Effect.fail(
            new Error(`Parameter group '${group.Name}' is missing its ARN`),
          );
        }
        return {
          parameterGroupName: group.Name,
          parameterGroupArn: group.ARN,
          family: group.Family,
          description: group.Description,
          tags: yield* readMemoryDbTags(group.ARN),
        };
      });

      return {
        stables: ["parameterGroupName", "parameterGroupArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news ?? { family: "" };
          const o = olds ?? { family: "" };
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          if (n.family !== o.family) {
            return { action: "replace" } as const;
          }
          // Descriptions have no update API.
          if ((n.description ?? undefined) !== (o.description ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.parameterGroupName ??
            (yield* toName(id, olds ?? { family: "" }));
          const group = yield* readGroup(name);
          if (!group?.ARN) return undefined;
          const attrs = yield* toAttrs(group);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const props = news!;
          const name = output?.parameterGroupName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };
          const desired = props.parameters ?? {};

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readGroup(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* memorydb
              .createParameterGroup({
                ParameterGroupName: name,
                Family: props.family,
                Description: props.description,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ParameterGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* readGroup(name);
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(`Parameter group '${name}' not found after create`),
            );
          }

          // 3. Sync parameters — diff desired values against OBSERVED cloud
          // values and apply only the delta. Parameters dropped from the
          // desired map (present in olds) are reset to the engine default.
          const observedParams = yield* readParameters(name);
          const changed = Object.entries(desired).filter(
            ([key, value]) => observedParams.get(key) !== value,
          );
          if (changed.length > 0) {
            yield* memorydb.updateParameterGroup({
              ParameterGroupName: name,
              ParameterNameValues: changed.map(
                ([ParameterName, ParameterValue]) => ({
                  ParameterName,
                  ParameterValue,
                }),
              ),
            });
          }
          const removed = Object.keys(olds?.parameters ?? {}).filter(
            (key) => !(key in desired),
          );
          if (removed.length > 0) {
            yield* memorydb
              .resetParameterGroup({
                ParameterGroupName: name,
                ParameterNames: removed,
              })
              .pipe(
                // A parameter already at its default resets to a no-op; a
                // group busy applying the previous update settles quickly.
                Effect.retry({
                  while: (e): boolean =>
                    e._tag === "InvalidParameterGroupStateFault",
                  schedule: Schedule.max([
                    Schedule.fixed("5 seconds"),
                    Schedule.recurs(8),
                  ]),
                }),
              );
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.ARN;
          if (arn) {
            const observedTags = yield* readMemoryDbTags(arn);
            const { removed: removedTags, upsert } = diffTags(
              observedTags,
              desiredTags,
            );
            if (upsert.length > 0) {
              yield* memorydb.tagResource({ ResourceArn: arn, Tags: upsert });
            }
            if (removedTags.length > 0) {
              yield* memorydb.untagResource({
                ResourceArn: arn,
                TagKeys: removedTags,
              });
            }
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A parameter group still referenced by a cluster (or mid-update)
          // rejects deletion with InvalidParameterGroupStateFault — retry
          // bounded. NotFound is success (idempotent delete).
          yield* memorydb
            .deleteParameterGroup({
              ParameterGroupName: output.parameterGroupName,
            })
            .pipe(
              Effect.catchTag("ParameterGroupNotFoundFault", () => Effect.void),
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "InvalidParameterGroupStateFault",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(12),
                ]),
              }),
            );
        }),

        list: () =>
          memorydb.describeParameterGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ParameterGroups ?? []).filter(
                  (group) =>
                    group.Name !== undefined &&
                    group.ARN !== undefined &&
                    // The engine-default groups (default.memorydb-*) are
                    // AWS-owned and cannot be deleted.
                    !group.Name.startsWith("default."),
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((group) => toAttrs(group), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
