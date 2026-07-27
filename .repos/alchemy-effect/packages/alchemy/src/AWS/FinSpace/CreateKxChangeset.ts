import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:CreateKxChangeset` — ingests data into a kdb database in the bound environment by creating a changeset from staged S3 objects — the Managed kdb data-ingestion primitive.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.CreateKxChangesetHttp)`.
 * @binding
 * @section Ingesting Data
 * @example Load Ticks from S3
 * ```typescript
 * const createChangeset = yield* AWS.FinSpace.CreateKxChangeset(kdb);
 *
 * const changeset = yield* createChangeset({
 *   databaseName: "ticks",
 *   changeRequests: [
 *     { changeType: "PUT", s3Path: "s3://bucket/2024.01.02/", dbPath: "/2024.01.02/" },
 *   ],
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CreateKxChangeset extends Binding.Service<
  CreateKxChangeset,
  "AWS.FinSpace.CreateKxChangeset",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.CreateKxChangesetRequest, "environmentId">,
    ) => Effect.Effect<
      SVC.CreateKxChangesetResponse,
      SVC.CreateKxChangesetError
    >
  >
> {}
export const CreateKxChangeset = Binding.Service<CreateKxChangeset>(
  "AWS.FinSpace.CreateKxChangeset",
);
