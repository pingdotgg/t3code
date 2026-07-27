import type * as mwaa from "@distilled.cloud/aws/mwaa";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AirflowRoleOptions } from "./BindingHttp.ts";
import type { Environment } from "./Environment.ts";

export interface InvokeRestApiRequest extends Omit<
  mwaa.InvokeRestApiRequest,
  "Name"
> {}

/**
 * Runtime binding for `airflow:InvokeRestApi` (Airflow 2.4.3+).
 *
 * Bind an {@link Environment} inside a function runtime to call the Apache
 * Airflow REST API on the environment's webserver — trigger DAG runs, list
 * DAGs, inspect task instances, manage variables and connections — without
 * minting tokens yourself. The IAM grant is scoped to the Airflow RBAC role
 * the call is mapped to (`Admin` by default — pass `{ airflowRole }` to
 * scope it down). Provide the implementation with
 * `Effect.provide(AWS.MWAA.InvokeRestApiHttp)`.
 * @binding
 * @section Invoking the Airflow REST API
 * @example List DAGs
 * ```typescript
 * // init — bind the operation to the environment
 * const invokeRestApi = yield* AWS.MWAA.InvokeRestApi(environment);
 *
 * // runtime — GET /dags through the Airflow REST API
 * const result = yield* invokeRestApi({
 *   Method: "GET",
 *   Path: "/dags",
 *   QueryParameters: { paused: false },
 * });
 * const dags = result.RestApiResponse as { dags: { dag_id: string }[] };
 * ```
 *
 * @example Trigger a DAG Run
 * ```typescript
 * const run = yield* invokeRestApi({
 *   Method: "POST",
 *   Path: "/dags/my_dag/dagRuns",
 *   Body: { conf: { source: "lambda" } },
 * });
 * ```
 */
export interface InvokeRestApi extends Binding.Service<
  InvokeRestApi,
  "AWS.MWAA.InvokeRestApi",
  (
    environment: Environment,
    options?: AirflowRoleOptions,
  ) => Effect.Effect<
    (
      request: InvokeRestApiRequest,
    ) => Effect.Effect<mwaa.InvokeRestApiResponse, mwaa.InvokeRestApiError>
  >
> {}

export const InvokeRestApi = Binding.Service<InvokeRestApi>(
  "AWS.MWAA.InvokeRestApi",
);
