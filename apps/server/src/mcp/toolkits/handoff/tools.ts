import { ThreadHandoffId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

export const RequestThreadHandoffInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  artifactReferences: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});

export const ThreadHandoffToolFailure = Schema.Struct({
  message: Schema.String,
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  Crypto.Crypto,
];

export const RequestThreadHandoffTool = Tool.make("request_thread_handoff", {
  description:
    "Request a user-confirmed handoff to a new thread. Use only when the current turn has completed a coherent phase and another thread should continue with a concise title and an editable initial prompt. This does not create or start the target; the user may open or dismiss it after this turn succeeds.",
  parameters: RequestThreadHandoffInput,
  success: Schema.Struct({ handoffId: ThreadHandoffId }),
  failure: ThreadHandoffToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Request thread handoff")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const ThreadHandoffToolkit = Toolkit.make(RequestThreadHandoffTool);
