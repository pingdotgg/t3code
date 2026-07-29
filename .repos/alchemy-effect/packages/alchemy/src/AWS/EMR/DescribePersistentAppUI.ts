import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:DescribePersistentAppUI` — reads a persistent application UI created for the bound cluster by {@link CreatePersistentAppUI}.
 * @binding
 * @section Application UIs
 * @example Wait for the UI to Attach
 * ```typescript
 * const describeAppUI = yield* AWS.EMR.DescribePersistentAppUI(cluster);
 *
 * const { PersistentAppUI } = yield* describeAppUI({
 *   PersistentAppUIId: appUIId,
 * });
 * ```
 */
export interface DescribePersistentAppUI extends Binding.Service<
  DescribePersistentAppUI,
  "AWS.EMR.DescribePersistentAppUI",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: SVC.DescribePersistentAppUIInput,
    ) => Effect.Effect<
      SVC.DescribePersistentAppUIOutput,
      SVC.DescribePersistentAppUIError
    >
  >
> {}
export const DescribePersistentAppUI = Binding.Service<DescribePersistentAppUI>(
  "AWS.EMR.DescribePersistentAppUI",
);
