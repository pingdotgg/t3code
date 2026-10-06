import type * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Attestor } from "./Attestor.ts";

export interface GetAttestorRequest extends Omit<
  binaryauthorization.GetProjectsAttestorsRequest,
  "name"
> {}

/**
 * Runtime binding for Binary Authorization `attestors.get`.
 *
 * Bind this operation to an {@link Attestor} in a Function/Action init
 * phase. Provide {@link GetAttestorHttp}.
 *
 * ### Reading an Attestor
 * **Example:** Get the bound attestor
 * ```typescript
 * const getAttestor = yield* GCP.BinaryAuthorization.GetAttestor(attestor);
 * const live = yield* getAttestor();
 * ```
 *
 * @binding
 * @category BinaryAuthorization
 */
export interface GetAttestor extends Binding.Service<
  GetAttestor,
  "GCP.BinaryAuthorization.GetAttestor",
  (
    attestor: Attestor,
  ) => Effect.Effect<
    (
      request?: GetAttestorRequest,
    ) => Effect.Effect<
      binaryauthorization.Attestor,
      binaryauthorization.GetProjectsAttestorsError,
      RuntimeContext
    >
  >
> {}

export const GetAttestor = Binding.Service<GetAttestor>(
  "GCP.BinaryAuthorization.GetAttestor",
);
