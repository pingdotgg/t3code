import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export interface ListCodeInterpreterSessionsRequest extends Omit<
  agentcore.ListCodeInterpreterSessionsRequest,
  "codeInterpreterIdentifier"
> {}

/**
 * Lists the code interpreter's sessions.
 *
 * Bind a {@link CodeInterpreter} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.ListCodeInterpreterSessionsHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Inspecting Sessions
 * @example List Sessions
 * ```typescript
 * // init
 * const listCodeInterpreterSessions = yield* AgentCore.ListCodeInterpreterSessions(codeInterpreter);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listCodeInterpreterSessions({});
 *     return HttpServerResponse.json({ count: result.items?.length ?? 0 });
 *   }),
 * };
 * ```
 */
export interface ListCodeInterpreterSessions extends Binding.Service<
  ListCodeInterpreterSessions,
  "AWS.BedrockAgentCore.ListCodeInterpreterSessions",
  <R extends CodeInterpreter>(
    codeInterpreter: R,
  ) => Effect.Effect<
    (
      request: ListCodeInterpreterSessionsRequest,
    ) => Effect.Effect<
      agentcore.ListCodeInterpreterSessionsResponse,
      agentcore.ListCodeInterpreterSessionsError
    >
  >
> {}
export const ListCodeInterpreterSessions =
  Binding.Service<ListCodeInterpreterSessions>(
    "AWS.BedrockAgentCore.ListCodeInterpreterSessions",
  );
