import * as Lambda from "@/AWS/Lambda";
import * as Omics from "@/AWS/Omics";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// A syntactically-plausible but nonexistent read-set / run id.
const BOGUS_ID = "0000000000";

export class OmicsBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "OmicsBindingsFunction",
) {}

export default OmicsBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const sequenceStore = yield* Omics.SequenceStore("BindingsSequenceStore");
    const referenceStore = yield* Omics.ReferenceStore(
      "BindingsReferenceStore",
    );

    // Resource-scoped bindings — the store id is injected automatically.
    const listReadSets = yield* Omics.ListReadSets(sequenceStore);
    const getReadSetMetadata = yield* Omics.GetReadSetMetadata(sequenceStore);
    const startReadSetImportJob =
      yield* Omics.StartReadSetImportJob(sequenceStore);
    const batchDeleteReadSet = yield* Omics.BatchDeleteReadSet(sequenceStore);
    const listReferences = yield* Omics.ListReferences(referenceStore);
    const getReferenceMetadata =
      yield* Omics.GetReferenceMetadata(referenceStore);

    // Account-level run-control bindings.
    const listRuns = yield* Omics.ListRuns();
    const getRun = yield* Omics.GetRun();

    const bound = {
      listReadSets,
      getReadSetMetadata,
      startReadSetImportJob,
      batchDeleteReadSet,
      listReferences,
      getReferenceMetadata,
      listRuns,
      getRun,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        if (request.method === "GET" && pathname === "/readsets") {
          // sequenceStoreId injection scopes the list to the bound store.
          const response = yield* listReadSets();
          return yield* HttpServerResponse.json({
            count: (response.readSets ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/references") {
          const response = yield* listReferences();
          return yield* HttpServerResponse.json({
            count: (response.references ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/runs") {
          const response = yield* listRuns();
          return yield* HttpServerResponse.json({
            count: (response.items ?? []).length,
          });
        }

        // The typed-not-found routes prove the grant + injection end-to-end:
        // an IAM gap would surface AccessDeniedException (a 500), while the
        // typed ResourceNotFoundException proves the request reached the API.
        if (
          request.method === "GET" &&
          pathname === "/readset/typed-not-found"
        ) {
          const typed = yield* getReadSetMetadata({ id: BOGUS_ID }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "GET" && pathname === "/run/typed-not-found") {
          const typed = yield* getRun({ id: BOGUS_ID }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
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
        Omics.ListReadSetsHttp,
        Omics.GetReadSetMetadataHttp,
        Omics.StartReadSetImportJobHttp,
        Omics.BatchDeleteReadSetHttp,
        Omics.ListReferencesHttp,
        Omics.GetReferenceMetadataHttp,
        Omics.ListRunsHttp,
        Omics.GetRunHttp,
      ),
    ),
  ),
);
