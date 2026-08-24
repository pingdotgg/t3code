import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:CreateFaceLivenessSession` — create a Face Liveness session whose ID the client-side FaceLivenessDetector component uses to run the liveness check.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:CreateFaceLivenessSession` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.CreateFaceLivenessSessionHttp)`.
 *
 * @binding
 * @section Face Liveness
 * @example Start a Liveness Check
 * ```typescript
 * // init
 * const createFaceLivenessSession = yield* AWS.Rekognition.CreateFaceLivenessSession();
 *
 * // runtime
 * const session = yield* createFaceLivenessSession({
 *   Settings: { AuditImagesLimit: 2 },
 * });
 * // hand session.SessionId to the front-end FaceLivenessDetector
 * ```
 */
export interface CreateFaceLivenessSession extends Binding.Service<
  CreateFaceLivenessSession,
  "AWS.Rekognition.CreateFaceLivenessSession",
  () => Effect.Effect<
    (
      request?: rekognition.CreateFaceLivenessSessionRequest,
    ) => Effect.Effect<
      rekognition.CreateFaceLivenessSessionResponse,
      rekognition.CreateFaceLivenessSessionError
    >
  >
> {}
export const CreateFaceLivenessSession =
  Binding.Service<CreateFaceLivenessSession>(
    "AWS.Rekognition.CreateFaceLivenessSession",
  );
