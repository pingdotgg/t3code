import type * as SVC from "@distilled.cloud/aws/databrew";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

export interface StartProjectSessionRequest extends Omit<
  SVC.StartProjectSessionRequest,
  "Name"
> {}

/**
 * Runtime binding for `databrew:StartProjectSession` — opens an interactive
 * session on the bound DataBrew project. The response's `ClientSessionId`
 * (a `Redacted` session token) authenticates subsequent
 * {@link SendProjectSessionAction} calls.
 *
 * Interactive sessions are billed per 30-minute session.
 * @binding
 * @section Interactive Sessions
 * @example Open a Session
 * ```typescript
 * const startProjectSession = yield* AWS.DataBrew.StartProjectSession(project);
 *
 * const { ClientSessionId } = yield* startProjectSession({
 *   AssumeControl: true,
 * });
 * ```
 */
export interface StartProjectSession extends Binding.Service<
  StartProjectSession,
  "AWS.DataBrew.StartProjectSession",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request?: StartProjectSessionRequest,
    ) => Effect.Effect<
      SVC.StartProjectSessionResponse,
      SVC.StartProjectSessionError
    >
  >
> {}
export const StartProjectSession = Binding.Service<StartProjectSession>(
  "AWS.DataBrew.StartProjectSession",
);
