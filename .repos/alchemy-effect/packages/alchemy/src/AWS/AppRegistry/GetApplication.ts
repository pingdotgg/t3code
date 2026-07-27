import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Runtime binding for `servicecatalog:GetApplication`.
 *
 * Reads the bound application's metadata — description, tags, the
 * `awsApplication` tag value, integrations, and the associated resource
 * count. Provide the implementation with
 * `Effect.provide(AWS.AppRegistry.GetApplicationHttp)`.
 * @binding
 * @section Reading Application Metadata
 * @example Read the Application at Runtime
 * ```typescript
 * // init — bind the operation to the application
 * const getApplication = yield* AWS.AppRegistry.GetApplication(app);
 *
 * // runtime
 * const details = yield* getApplication();
 * console.log(details.name, details.associatedResourceCount);
 * ```
 */
export interface GetApplication extends Binding.Service<
  GetApplication,
  "AWS.AppRegistry.GetApplication",
  (
    application: Application,
  ) => Effect.Effect<
    () => Effect.Effect<
      appregistry.GetApplicationResponse,
      appregistry.GetApplicationError
    >
  >
> {}

export const GetApplication = Binding.Service<GetApplication>(
  "AWS.AppRegistry.GetApplication",
);
