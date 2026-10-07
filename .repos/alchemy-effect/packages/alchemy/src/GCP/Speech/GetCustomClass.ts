import type * as speech from "@distilled.cloud/gcp/speech_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CustomClass } from "./CustomClass.ts";

export interface GetCustomClassRequest extends Omit<
  speech.GetProjectsLocationsCustomClassesRequest,
  "name"
> {}

/**
 * Runtime binding for Speech-to-Text `customClasses.get`.
 *
 * Bind this operation to a {@link CustomClass} in a Function/Action
 * init phase. Provide {@link GetCustomClassHttp}.
 *
 * Grants `roles/speech.client` on the project because Speech-to-Text has no
 * resource-level IAM.
 *
 * ### Reading a Custom Class
 * **Example:** Read the bound custom class
 * ```typescript
 * const getClass = yield* GCP.Speech.GetCustomClass(ships);
 * const live = yield* getClass();
 * ```
 *
 * @binding
 * @category Speech
 */
export interface GetCustomClass extends Binding.Service<
  GetCustomClass,
  "GCP.Speech.GetCustomClass",
  (
    customClass: CustomClass,
  ) => Effect.Effect<
    (
      request?: GetCustomClassRequest,
    ) => Effect.Effect<
      speech.CustomClass,
      speech.GetProjectsLocationsCustomClassesError,
      RuntimeContext
    >
  >
> {}

export const GetCustomClass = Binding.Service<GetCustomClass>(
  "GCP.Speech.GetCustomClass",
);
