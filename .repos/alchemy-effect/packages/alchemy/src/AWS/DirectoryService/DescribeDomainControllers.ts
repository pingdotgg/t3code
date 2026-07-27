import type * as ds from "@distilled.cloud/aws/directory-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Directory } from "./Directory.ts";

/**
 * Runtime binding for the `DescribeDomainControllers` operation (IAM action
 * `ds:DescribeDomainControllers`), scoped to one {@link Directory}.
 *
 * Lists the bound directory's domain controllers — id, DNS address,
 * Availability Zone, and status (`Active`, `Impaired`, …) — so a monitoring
 * function can alert on an impaired controller. The directory id is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.DirectoryService.DescribeDomainControllersHttp)`.
 * @binding
 * @section Monitoring the Directory
 * @example Alert on Impaired Domain Controllers
 * ```typescript
 * // init — bind the operation to the directory
 * const describeDomainControllers =
 *   yield* AWS.DirectoryService.DescribeDomainControllers(directory);
 *
 * // runtime
 * const { DomainControllers } = yield* describeDomainControllers();
 * for (const controller of DomainControllers ?? []) {
 *   if (controller.Status === "Impaired") {
 *     yield* Effect.logError(`impaired controller: ${controller.DomainControllerId}`);
 *   }
 * }
 * ```
 */
export interface DescribeDomainControllers extends Binding.Service<
  DescribeDomainControllers,
  "AWS.DirectoryService.DescribeDomainControllers",
  (
    directory: Directory,
  ) => Effect.Effect<
    (
      request?: Omit<ds.DescribeDomainControllersRequest, "DirectoryId">,
    ) => Effect.Effect<
      ds.DescribeDomainControllersResult,
      ds.DescribeDomainControllersError
    >
  >
> {}
export const DescribeDomainControllers =
  Binding.Service<DescribeDomainControllers>(
    "AWS.DirectoryService.DescribeDomainControllers",
  );
