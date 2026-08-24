import * as keyspaces from "@distilled.cloud/aws/keyspaces";
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

export interface KeyspaceProps {
  /**
   * Name of the keyspace. Must be 1-48 characters of `[a-zA-Z0-9_]`. If
   * omitted a deterministic physical name is generated. Changing the name
   * replaces the keyspace.
   */
  keyspaceName?: string;
  /**
   * User-defined tags for the keyspace.
   */
  tags?: Record<string, string>;
}

export interface Keyspace extends Resource<
  "AWS.Keyspaces.Keyspace",
  KeyspaceProps,
  {
    /**
     * The keyspace's physical name.
     */
    keyspaceName: string;
    /**
     * ARN of the keyspace.
     */
    keyspaceArn: string;
    /**
     * Replication strategy of the keyspace (`SINGLE_REGION` or
     * `MULTI_REGION`).
     */
    replicationStrategy: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Keyspaces (for Apache Cassandra) keyspace — the top-level
 * container for Cassandra tables.
 *
 * Keyspaces are serverless, free to create, and provisioned near-instantly,
 * so they make excellent building blocks and test fixtures.
 * @resource
 * @section Creating a Keyspace
 * @example Basic Keyspace
 * ```typescript
 * const keyspace = yield* Keyspace("AppData", {});
 * ```
 *
 * @example Named Keyspace with Tags
 * ```typescript
 * const keyspace = yield* Keyspace("AppData", {
 *   keyspaceName: "app_data",
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const Keyspace = Resource<Keyspace>("AWS.Keyspaces.Keyspace");

const toTagRecord = (
  tags: keyspaces.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.key, t.value]));

/**
 * Reserved Cassandra system keyspaces that exist in every Amazon Keyspaces
 * account and can never be deleted. Excluded from `list()` so account-wide
 * teardown (`alchemy unsafe nuke`) doesn't loop on undeletable resources.
 */
const SYSTEM_KEYSPACES = new Set([
  "system",
  "system_schema",
  "system_schema_mcs",
  "system_multiregion_info",
]);

export const KeyspaceProvider = () =>
  Provider.effect(
    Keyspace,
    Effect.gen(function* () {
      const toName = (id: string, props: KeyspaceProps) =>
        props.keyspaceName
          ? Effect.succeed(props.keyspaceName)
          : createPhysicalName({ id, maxLength: 48 }).pipe(
              Effect.map((n) => n.replaceAll("-", "_")),
            );

      const readKeyspace = Effect.fn(function* (name: string) {
        return yield* keyspaces
          .getKeyspace({ keyspaceName: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const readTags = Effect.fn(function* (arn: string) {
        const tags = yield* keyspaces.listTagsForResource
          .items({ resourceArn: arn })
          .pipe(
            Stream.runCollect,
            Effect.map((c) => Array.from(c)),
            Effect.catch(() => Effect.succeed<keyspaces.Tag[]>([])),
          );
        return toTagRecord(tags);
      });

      return {
        stables: ["keyspaceName", "keyspaceArn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.keyspaceName ?? (yield* toName(id, olds ?? {}));
          const found = yield* readKeyspace(name);
          if (found === undefined) return undefined;
          const attrs = {
            keyspaceName: found.keyspaceName,
            keyspaceArn: found.resourceArn,
            replicationStrategy: found.replicationStrategy,
          };
          const tags = yield* readTags(found.resourceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name = output?.keyspaceName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readKeyspace(name);

          // 2. Ensure — create if missing; tolerate the AlreadyExists race.
          if (observed === undefined) {
            yield* keyspaces
              .createKeyspace({
                keyspaceName: name,
                tags: Object.entries(desiredTags).map(([key, value]) => ({
                  key,
                  value,
                })),
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            // Keyspace creation is effectively synchronous, but GetKeyspace can
            // briefly 404 right after create; retry a few times.
            observed = yield* readKeyspace(name).pipe(
              Effect.flatMap((k) =>
                k === undefined
                  ? Effect.fail(new Error(`Keyspace '${name}' not found`))
                  : Effect.succeed(k),
              ),
              Effect.retry({
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
            );
          }

          // 3. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readTags(observed.resourceArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* keyspaces.tagResource({
              resourceArn: observed.resourceArn,
              tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* keyspaces.untagResource({
              resourceArn: observed.resourceArn,
              tags: removed.map((key) => ({ key, value: "" })),
            });
          }

          yield* session.note(name);
          return {
            keyspaceName: observed.keyspaceName,
            keyspaceArn: observed.resourceArn,
            replicationStrategy: observed.replicationStrategy,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.keyspaceName;
          yield* keyspaces.deleteKeyspace({ keyspaceName: name }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // A keyspace whose tables are still deleting rejects with
            // ConflictException; retry briefly.
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );
          // Deletion is asynchronous — wait (bounded) until the keyspace is
          // actually gone so a subsequent recreate with the same name does not
          // hit ConflictException.
          yield* readKeyspace(name).pipe(
            Effect.flatMap((k) =>
              k === undefined
                ? Effect.void
                : Effect.fail(new Error(`Keyspace '${name}' still deleting`)),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
            Effect.catch(() => Effect.void),
          );
        }),

        list: () =>
          keyspaces.listKeyspaces.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .filter((k) => !SYSTEM_KEYSPACES.has(k.keyspaceName))
                .map((k) => ({
                  keyspaceName: k.keyspaceName,
                  keyspaceArn: k.resourceArn,
                  replicationStrategy: k.replicationStrategy,
                })),
            ),
          ),
      };
    }),
  );
