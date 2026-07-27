import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link ListQApps} — `instanceId` is injected from the bound Q App.
 */
export interface ListQAppsRequest extends Omit<
  qapps.ListQAppsInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:ListQApps`.
 *
 * Lists the calling identity's Q Apps in the bound app's Q Business application environment instance. Provide the implementation with
 * `Effect.provide(AWS.QApps.ListQAppsHttp)`.
 * @binding
 * @section User Inventory
 * @example List the User's Q Apps
 * ```typescript
 * // init — bind the operation to the Q App
 * const listQApps = yield* AWS.QApps.ListQApps(app);
 *
 * // runtime
 * const page = yield* listQApps({ limit: 25 });
 * console.log(page.apps.map((a) => a.title));
 * ```
 */
export interface ListQApps extends Binding.Service<
  ListQApps,
  "AWS.QApps.ListQApps",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request?: ListQAppsRequest,
    ) => Effect.Effect<qapps.ListQAppsOutput, qapps.ListQAppsError>
  >
> {}

export const ListQApps = Binding.Service<ListQApps>("AWS.QApps.ListQApps");
