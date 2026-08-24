import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:CreatePersistentAppUI` — creates a persistent application UI (Spark history, YARN timeline) for the bound cluster — the UI outlives the cluster. The cluster ARN is injected as `TargetResourceArn`.
 * @binding
 * @section Application UIs
 * @example Create a Persistent Spark History UI
 * ```typescript
 * const createAppUI = yield* AWS.EMR.CreatePersistentAppUI(cluster);
 *
 * const { PersistentAppUIId } = yield* createAppUI();
 * ```
 */
export interface CreatePersistentAppUI extends Binding.Service<
  CreatePersistentAppUI,
  "AWS.EMR.CreatePersistentAppUI",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.CreatePersistentAppUIInput, "TargetResourceArn">,
    ) => Effect.Effect<
      SVC.CreatePersistentAppUIOutput,
      SVC.CreatePersistentAppUIError
    >
  >
> {}
export const CreatePersistentAppUI = Binding.Service<CreatePersistentAppUI>(
  "AWS.EMR.CreatePersistentAppUI",
);
