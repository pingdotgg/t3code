import type * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  sqladmin.GetInstancesRequest,
  "instance" | "project"
> {}

/**
 * Runtime binding for Cloud SQL `instances.get`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetInstanceHttp}.
 *
 * Grants `roles/cloudsql.viewer` on the project under an IAM Condition
 * naming only this instance (Cloud SQL has no instance-level IAM policy).
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.SQL.GetInstance(db);
 * const live = yield* getInstance();
 * ```
 *
 * @binding
 * @category SQL
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "GCP.SQL.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<
      sqladmin.DatabaseInstance,
      sqladmin.GetInstancesError,
      RuntimeContext
    >
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("GCP.SQL.GetInstance");
