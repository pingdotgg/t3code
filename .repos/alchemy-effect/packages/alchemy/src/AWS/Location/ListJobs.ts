import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Lists the account's Location batch metadata jobs (e.g. batch address validation jobs).
 *
 * Runtime binding for the `ListJobs` operation (IAM action
 * `geo:ListJobs`), account-scoped — batch jobs are created at runtime so the
 * grant is on `*`. Provide the implementation with
 * `Effect.provide(AWS.Location.ListJobsHttp)`.
 *
 * @binding
 * @section Managing Batch Jobs
 * @example List Batch Jobs
 * ```typescript
 * const listJobs = yield* Location.ListJobs();
 *
 * const page = yield* listJobs();
 * // page.Entries → [{ JobId, Status, Action }, …]
 * ```
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.Location.ListJobs",
  () => Effect.Effect<
    (
      request?: location.ListJobsRequest,
    ) => Effect.Effect<location.ListJobsResponse, location.ListJobsError>
  >
> {}
export const ListJobs = Binding.Service<ListJobs>("AWS.Location.ListJobs");
