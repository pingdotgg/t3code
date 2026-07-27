import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Namespace from "../../Namespace.ts";
import {
  ClusterEventSource as DocDBClusterEventSourceContract,
  type ClusterEventSourceProps,
  type ClusterEventSourceService,
  type DocumentDBRecord,
} from "../DocDB/ClusterEventSource.ts";
import type { DBCluster } from "../DocDB/DBCluster.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import * as Lambda from "./Function.ts";

export const isDocumentDBEvent = (
  event: any,
): event is { eventSourceArn?: string; events: unknown[] } =>
  typeof event?.eventSourceArn === "string" && Array.isArray(event?.events);

/** @binding */
export const DocDBClusterEventSource = Layer.effect(
  DocDBClusterEventSourceContract,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* <TDoc = unknown, Req = never>(
      cluster: DBCluster,
      props: ClusterEventSourceProps,
      process: (
        stream: Stream.Stream<DocumentDBRecord<TDoc>>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const ClusterArn = yield* cluster.dbClusterArn;

      // Deploy-time: grant IAM (secret access) and create the DocumentDB
      // event-source mapping. Skipped once running inside the deployed Function
      // (the global guard), where the only work is registering the runtime
      // handler below. Namespaced under the host so the mapping's logical
      // identity is stable.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* host.bind`Allow(${host}, AWS.DocDB.ClusterEventSource(${cluster}))`(
              {
                policyStatements: [
                  {
                    Effect: "Allow",
                    Action: ["secretsmanager:GetSecretValue"],
                    Resource: [props.secretArn],
                  },
                ],
              },
            );

            yield* Mapping(
              `AWS.Lambda.EventSourceMapping(${host.LogicalId}, ${cluster.LogicalId})`,
              {
                functionName: host.functionName,
                eventSourceArn: cluster.dbClusterArn,
                startingPosition: props.startingPosition ?? "LATEST",
                batchSize: props.batchSize,
                maximumBatchingWindow: props.maximumBatchingWindow,
                enabled: props.enabled ?? true,
                documentDBEventSourceConfig: {
                  DatabaseName: props.databaseName,
                  CollectionName: props.collectionName,
                  FullDocument: props.fullDocument ?? "Default",
                },
                sourceAccessConfigurations: [
                  { Type: "BASIC_AUTH", URI: props.secretArn },
                ],
              },
            );
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          const clusterArn = yield* ClusterArn;
          return (event: any) => {
            if (
              isDocumentDBEvent(event) &&
              event.eventSourceArn === clusterArn
            ) {
              return process(
                Stream.fromArray(event.events as DocumentDBRecord<TDoc>[]),
              ).pipe(Effect.orDie);
            }
          };
        }),
      );
    }) as ClusterEventSourceService;
  }),
);
