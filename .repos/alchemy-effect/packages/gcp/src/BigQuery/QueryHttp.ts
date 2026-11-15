import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Dataset } from "./Dataset.ts";
import { Query, type QueryRequest } from "./Query.ts";

/**
 * HTTP implementation of {@link Query}.
 *
 * @layer
 * @provides GCP.BigQuery.Query
 */
export const QueryHttp = Layer.effect(
  Query,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const queryJobs = yield* GCPBindings.withCredentials(bigquery.queryJobs);
    return Effect.fn(function* (dataset: Dataset) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BigQuery.Query(${dataset})`({
          iam: [
            // bigquery.jobs.create is only grantable on the project.
            { role: "roles/bigquery.jobUser" },
            // Read access on this dataset only (its access list).
            grantFor({ role: "roles/bigquery.dataViewer", on: "bigquery.dataset" }, dataset.name),
          ],
        });
      }
      const project = yield* dataset.project;
      const datasetId = yield* dataset.datasetId;
      const location = yield* dataset.location;
      return Effect.fn(`GCP.BigQuery.Query(${dataset.LogicalId})`)(function* (
        request: QueryRequest,
      ) {
        return yield* queryJobs({
          projectId: yield* project,
          body: {
            useLegacySql: false,
            location: yield* location,
            ...request,
            defaultDataset: request.defaultDataset ?? {
              projectId: yield* project,
              datasetId: yield* datasetId,
            },
          },
        });
      });
    });
  }),
);
