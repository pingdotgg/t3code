import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/**
 * The `stageArn` is injected by the binding from the bound stage, and the
 * wire `duration` (whole minutes) is expressed as a `Duration.Input`.
 */
export interface CreateParticipantTokenRequest extends Omit<
  ivsrealtime.CreateParticipantTokenRequest,
  "stageArn" | "duration"
> {
  /**
   * How long the issued participant token remains valid. Converted to whole
   * minutes on the wire (`1` - `20160` minutes, i.e. up to 14 days).
   * @default 720 minutes (12 hours)
   */
  duration?: Duration.Input;
}

/**
 * Mint a participant token that an end user presents to join the bound
 * stage — the effectful call made from a deployed Lambda or Task. The
 * `capabilities` field grants `PUBLISH` and/or `SUBSCRIBE` to the token
 * holder; `attributes` attaches profile data (display name, avatar, …) that
 * is visible to other participants. The returned `token` is sensitive and
 * surfaces as a `Redacted` value.
 *
 * @binding
 * @section Minting Participant Tokens
 * Provide the `CreateParticipantTokenHttp` implementation layer on the
 * Function effect, bind the stage in the init phase, then call the returned
 * client at runtime. The binding grants `ivs:CreateParticipantToken` on the
 * stage and injects its ARN automatically.
 *
 * @example Mint a token from a Lambda
 * ```typescript
 * // init
 * const stage = yield* IVSRealtime.Stage("VideoRoom");
 * const createParticipantToken = yield* IVSRealtime.CreateParticipantToken(stage);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { participantToken } = yield* createParticipantToken({
 *       userId: "user-123",
 *       capabilities: ["PUBLISH", "SUBSCRIBE"],
 *       duration: "30 minutes",
 *       attributes: { displayName: "Sam" },
 *     });
 *     return HttpServerResponse.json({
 *       token:
 *         participantToken?.token !== undefined
 *           ? Redacted.value(participantToken.token)
 *           : undefined,
 *       participantId: participantToken?.participantId,
 *     });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(IVSRealtime.CreateParticipantTokenHttp))
 * ```
 */
export interface CreateParticipantToken extends Binding.Service<
  CreateParticipantToken,
  "AWS.IVSRealtime.CreateParticipantToken",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request?: CreateParticipantTokenRequest,
    ) => Effect.Effect<
      ivsrealtime.CreateParticipantTokenResponse,
      ivsrealtime.CreateParticipantTokenError
    >
  >
> {}
export const CreateParticipantToken = Binding.Service<CreateParticipantToken>(
  "AWS.IVSRealtime.CreateParticipantToken",
);
