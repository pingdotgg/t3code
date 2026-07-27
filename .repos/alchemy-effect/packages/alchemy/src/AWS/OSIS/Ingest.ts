import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { IngestRequest, PipelineIngestError } from "./BindingHttp.ts";
import type { Pipeline } from "./Pipeline.ts";

export type { IngestRequest } from "./BindingHttp.ts";
export { PipelineIngestError } from "./BindingHttp.ts";

/**
 * Runtime binding for the `osis:Ingest` data plane.
 *
 * Sends events into the bound {@link Pipeline}'s ingest endpoint — the
 * pipeline's actual data plane. There is no SDK operation for ingestion;
 * each batch is a SigV4-signed HTTP POST (service `"osis"`) to the
 * pipeline's ingest endpoint URL, made with the host Function's own
 * credentials. The endpoint and pipeline name are injected from the binding;
 * pass the source `path` configured on the pipeline's `http` source and the
 * batch of events. Provide the implementation with
 * `Effect.provide(AWS.OSIS.IngestHttp)`.
 * @binding
 * @section Ingesting Data
 * @example Send a Batch of Log Events
 * ```typescript
 * // init — bind the data plane to the pipeline
 * const ingest = yield* AWS.OSIS.Ingest(pipeline);
 *
 * // runtime — path must match the pipeline config's http source path
 * yield* ingest({
 *   path: "/logs/ingest",
 *   events: [{ message: "hello", level: "info" }],
 * });
 * ```
 */
export interface Ingest extends Binding.Service<
  Ingest,
  "AWS.OSIS.Ingest",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    (
      request: IngestRequest,
    ) => Effect.Effect<void, PipelineIngestError | Credentials.CredentialsError>
  >
> {}
export const Ingest = Binding.Service<Ingest>("AWS.OSIS.Ingest");
