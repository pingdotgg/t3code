import type * as SVC from "@distilled.cloud/aws/databrew";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

export interface SendProjectSessionActionRequest extends Omit<
  SVC.SendProjectSessionActionRequest,
  "Name"
> {}

/**
 * Runtime binding for `databrew:SendProjectSessionAction` — performs a
 * recipe step (optionally as a preview) inside an open interactive session
 * on the bound DataBrew project. Authenticate with the `Redacted`
 * `ClientSessionId` returned by {@link StartProjectSession}.
 * @binding
 * @section Interactive Sessions
 * @example Preview a Recipe Step
 * ```typescript
 * const sendProjectSessionAction =
 *   yield* AWS.DataBrew.SendProjectSessionAction(project);
 *
 * const { ActionId } = yield* sendProjectSessionAction({
 *   Preview: true,
 *   ClientSessionId: clientSessionId,
 *   ViewFrame: { StartColumnIndex: 0 },
 * });
 * ```
 */
export interface SendProjectSessionAction extends Binding.Service<
  SendProjectSessionAction,
  "AWS.DataBrew.SendProjectSessionAction",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request?: SendProjectSessionActionRequest,
    ) => Effect.Effect<
      SVC.SendProjectSessionActionResponse,
      SVC.SendProjectSessionActionError
    >
  >
> {}
export const SendProjectSessionAction =
  Binding.Service<SendProjectSessionAction>(
    "AWS.DataBrew.SendProjectSessionAction",
  );
