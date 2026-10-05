import type * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Release } from "./Release.ts";

export interface GetReleaseExecutableRequest extends Omit<
  firebaserules.GetExecutableProjectsReleasesRequest,
  "name"
> {}

/**
 * Runtime binding for Firebase Rules `releases.getExecutable`.
 *
 * Bind this operation to a {@link Release} in a Function/Action init
 * phase. Provide {@link GetReleaseExecutableHttp}.
 *
 * ### Reading a Release Executable
 * **Example:** Fetch the compiled executable
 * ```typescript
 * const getExecutable = yield* GCP.FirebaseRules.GetReleaseExecutable(
 *   release,
 * );
 * const { rulesetName, executableVersion } = yield* getExecutable();
 * ```
 *
 * @binding
 * @category FirebaseRules
 */
export interface GetReleaseExecutable extends Binding.Service<
  GetReleaseExecutable,
  "GCP.FirebaseRules.GetReleaseExecutable",
  (
    release: Release,
  ) => Effect.Effect<
    (
      request?: GetReleaseExecutableRequest,
    ) => Effect.Effect<
      firebaserules.GetReleaseExecutableResponse,
      firebaserules.GetExecutableProjectsReleasesError,
      RuntimeContext
    >
  >
> {}

export const GetReleaseExecutable = Binding.Service<GetReleaseExecutable>(
  "GCP.FirebaseRules.GetReleaseExecutable",
);
