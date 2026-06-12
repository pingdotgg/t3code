import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBClusterEndpointProps {
  /**
   * Endpoint identifier. If omitted, Alchemy generates one.
   */
  dbClusterEndpointIdentifier?: string;
  /**
   * Cluster that owns the endpoint.
   */
  dbClusterIdentifier: string;
  /**
   * Endpoint type such as `READER`, `WRITER`, or `ANY`.
   */
  endpointType: string;
  /**
   * Static members explicitly attached to the endpoint.
   */
  staticMembers?: string[];
  /**
   * Members excluded from the endpoint.
   */
  excludedMembers?: string[];
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBClusterEndpoint extends Resource<
  "AWS.RDS.DBClusterEndpoint",
  DBClusterEndpointProps,
  {
    dbClusterEndpointIdentifier: string;
    dbClusterEndpointArn: string | undefined;
    dbClusterIdentifier: string | undefined;
    endpoint: string | undefined;
    status: string | undefined;
    endpointType: string | undefined;
    customEndpointType: string | undefined;
    staticMembers: string[];
    excludedMembers: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A custom Aurora cluster endpoint.
 */
export const DBClusterEndpoint = Resource<DBClusterEndpoint>(
  "AWS.RDS.DBClusterEndpoint",
);

const toAttrs = ({
  endpoint,
  tags,
}: {
  endpoint: rds.DBClusterEndpoint;
  tags: Record<string, string>;
}): DBClusterEndpoint["Attributes"] => ({
  dbClusterEndpointIdentifier: endpoint.DBClusterEndpointIdentifier ?? "",
  dbClusterEndpointArn: endpoint.DBClusterEndpointArn,
  dbClusterIdentifier: endpoint.DBClusterIdentifier,
  endpoint: endpoint.Endpoint,
  status: endpoint.Status,
  endpointType: endpoint.EndpointType,
  customEndpointType: endpoint.CustomEndpointType,
  staticMembers: endpoint.StaticMembers ?? [],
  excludedMembers: endpoint.ExcludedMembers ?? [],
  tags,
});

export const DBClusterEndpointProvider = () =>
  Provider.effect(
    DBClusterEndpoint,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBClusterEndpointProps) =>
        props.dbClusterEndpointIdentifier
          ? Effect.succeed(props.dbClusterEndpointIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readEndpoint = Effect.fn(function* (identifier: string) {
        const response = yield* rds
          .describeDBClusterEndpoints({
            DBClusterEndpointIdentifier: identifier,
          })
          .pipe(
            Effect.catchTag("DBClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusterEndpoints?.[0];
      });

      return {
        stables: ["dbClusterEndpointArn", "dbClusterEndpointIdentifier"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toIdentifier(
              id,
              olds ?? ({} as DBClusterEndpointProps),
            )) !== (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (olds?.dbClusterIdentifier !== news.dbClusterIdentifier) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbClusterEndpointIdentifier ??
            (yield* toIdentifier(
              id,
              olds ??
                ({
                  dbClusterIdentifier: "",
                  endpointType: "READER",
                } as DBClusterEndpointProps),
            ));
          const endpoint = yield* readEndpoint(identifier);
          if (!endpoint?.DBClusterEndpointIdentifier) {
            return undefined;
          }
          return toAttrs({ endpoint, tags: output?.tags ?? {} });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbClusterEndpointIdentifier ??
            (yield* toIdentifier(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch the endpoint's live state.
          let observed = yield* readEndpoint(identifier);

          // Ensure — create if missing. Tolerate
          // `DBClusterEndpointAlreadyExistsFault` as a race with a peer
          // reconciler.
          if (!observed?.DBClusterEndpointIdentifier) {
            yield* rds
              .createDBClusterEndpoint({
                DBClusterIdentifier: news.dbClusterIdentifier,
                DBClusterEndpointIdentifier: identifier,
                EndpointType: news.endpointType,
                StaticMembers: news.staticMembers,
                ExcludedMembers: news.excludedMembers,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "DBClusterEndpointAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* readEndpoint(identifier);
            if (!observed?.DBClusterEndpointIdentifier) {
              return yield* Effect.fail(
                new Error(
                  `DB cluster endpoint '${identifier}' not found after create`,
                ),
              );
            }
          } else {
            // Sync mutable endpoint config — push desired shape.
            yield* rds.modifyDBClusterEndpoint({
              DBClusterEndpointIdentifier: identifier,
              EndpointType: news.endpointType,
              StaticMembers: news.staticMembers,
              ExcludedMembers: news.excludedMembers,
            });
            observed = yield* readEndpoint(identifier);
            if (!observed?.DBClusterEndpointIdentifier) {
              return yield* Effect.fail(
                new Error(
                  `DB cluster endpoint '${identifier}' not found after update`,
                ),
              );
            }
          }

          const dbClusterEndpointArn = observed.DBClusterEndpointArn;

          // Sync tags — diff observed cloud tags against desired. The
          // describeDBClusterEndpoints response does not include tags, so we
          // diff against the previously-recorded tag set on `output`.
          const observedTags = output?.tags ?? {};
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbClusterEndpointArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbClusterEndpointArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbClusterEndpointArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbClusterEndpointArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbClusterEndpointArn ?? identifier);
          return toAttrs({ endpoint: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBClusterEndpoint({
              DBClusterEndpointIdentifier: output.dbClusterEndpointIdentifier,
            })
            .pipe(
              Effect.catchTag(
                "DBClusterEndpointNotFoundFault",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
