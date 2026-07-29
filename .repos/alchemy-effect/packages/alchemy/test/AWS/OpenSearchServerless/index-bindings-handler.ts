import * as Lambda from "@/AWS/Lambda";
import * as AOSS from "@/AWS/OpenSearchServerless";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "index-bindings-handler.ts");

// Deterministic names, distinct from Collection.test.ts so the suites never
// collide. ≤32 chars, lowercase.
export const COLLECTION_NAME = "alchemy-aossb";
export const ENC_POLICY = "alchemy-aossb-enc";
export const NET_POLICY = "alchemy-aossb-net";

const INDEX_NAME = "alchemy-roundtrip";

export class AossIndexFunction extends Lambda.Function<Lambda.Function>()(
  "AossIndexFunction",
) {}

export default AossIndexFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // The collection (and its prerequisite encryption/network policies) is
    // deployed as part of the fixture; the data access policy granting THIS
    // function's role lives in the test (it needs the function's roleArn).
    const enc = yield* AOSS.SecurityPolicy("Enc", {
      policyName: ENC_POLICY,
      type: "encryption",
      policy: {
        Rules: [
          {
            ResourceType: "collection",
            Resource: [`collection/${COLLECTION_NAME}`],
          },
        ],
        AWSOwnedKey: true,
      },
    });
    const net = yield* AOSS.SecurityPolicy("Net", {
      policyName: NET_POLICY,
      type: "network",
      policy: [
        {
          Rules: [
            {
              ResourceType: "collection",
              Resource: [`collection/${COLLECTION_NAME}`],
            },
          ],
          AllowFromPublic: true,
        },
      ],
    });
    const collection = yield* AOSS.Collection("Collection", {
      collectionName: COLLECTION_NAME,
      type: "SEARCH",
      standbyReplicas: "DISABLED",
      // Reference the policies so the engine orders them before the
      // collection (the encryption policy is a hard create prerequisite).
      tags: { encPolicy: enc.policyName, netPolicy: net.policyName },
    });

    const getCollection = yield* AOSS.GetCollection(collection);
    const createIndex = yield* AOSS.CreateIndex(collection);
    const getIndex = yield* AOSS.GetIndex(collection);
    const updateIndex = yield* AOSS.UpdateIndex(collection);
    const deleteIndex = yield* AOSS.DeleteIndex(collection);

    const bound = {
      getCollection,
      createIndex,
      getIndex,
      updateIndex,
      deleteIndex,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/collection") {
          const detail = yield* getCollection();
          return yield* HttpServerResponse.json({
            id: detail?.id,
            status: detail?.status,
            endpoint: detail?.collectionEndpoint,
          });
        }

        if (request.method === "POST" && pathname === "/index/roundtrip") {
          // Create → read → update → delete: exercises the runtime
          // multi-tenant index pattern end-to-end and leaves no orphan. A
          // crashed previous invocation surfaces the typed ConflictException
          // on create — treat the existing index as the winner.
          yield* createIndex({
            indexName: INDEX_NAME,
            indexSchema: {
              mappings: { properties: { title: { type: "text" } } },
            },
          }).pipe(Effect.catchTag("ConflictException", () => Effect.void));

          // Index visibility is eventually consistent — retry the read
          // through the typed not-found window (bounded, ~30s).
          const read = yield* Effect.retry(
            getIndex({ indexName: INDEX_NAME }),
            {
              while: (e): boolean => e._tag === "ResourceNotFoundException",
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(10),
              ]),
            },
          );

          yield* updateIndex({
            indexName: INDEX_NAME,
            indexSchema: {
              mappings: {
                properties: { body: { type: "text" } },
              },
            },
          });

          yield* deleteIndex({ indexName: INDEX_NAME }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          return yield* HttpServerResponse.json({
            created: true,
            hadSchema: read.indexSchema !== undefined,
            deleted: true,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AOSS.GetCollectionHttp,
        AOSS.CreateIndexHttp,
        AOSS.GetIndexHttp,
        AOSS.UpdateIndexHttp,
        AOSS.DeleteIndexHttp,
      ),
    ),
  ),
);
