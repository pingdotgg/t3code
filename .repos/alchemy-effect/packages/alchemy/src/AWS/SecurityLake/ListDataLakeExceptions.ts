import type * as securitylake from "@distilled.cloud/aws/securitylake";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataLake } from "./DataLake.ts";

/**
 * Runtime binding for `securitylake:ListDataLakeExceptions`.
 *
 * Enumerates the Security Lake exceptions (per-Region failures with
 * remediation hints) so a monitoring Function can surface or alert on
 * collection problems. Bind the account's {@link DataLake}.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityLake.ListDataLakeExceptionsHttp)`.
 * @binding
 * @section Monitoring the data lake
 * @example List current exceptions
 * ```typescript
 * // init
 * const listExceptions = yield* AWS.SecurityLake.ListDataLakeExceptions(lake);
 *
 * // runtime
 * const { exceptions } = yield* listExceptions();
 * ```
 */
export interface ListDataLakeExceptions extends Binding.Service<
  ListDataLakeExceptions,
  "AWS.SecurityLake.ListDataLakeExceptions",
  (
    lake: DataLake,
  ) => Effect.Effect<
    (
      request?: securitylake.ListDataLakeExceptionsRequest,
    ) => Effect.Effect<
      securitylake.ListDataLakeExceptionsResponse,
      securitylake.ListDataLakeExceptionsError
    >
  >
> {}
export const ListDataLakeExceptions = Binding.Service<ListDataLakeExceptions>(
  "AWS.SecurityLake.ListDataLakeExceptions",
);
