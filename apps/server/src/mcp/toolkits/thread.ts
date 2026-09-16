import { CommandId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";

class ThreadRenameFailedError extends Schema.TaggedError<ThreadRenameFailedError>()(
  "ThreadRenameFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not rename the thread.";
  }
}

const RenameThreadTool = Tool.make("rename_thread", {
  description:
    "Rename the thread you are running in. Use it when the user or a skill asks for a specific title, such as a task ID followed by a short description. The title is used verbatim and kept as user-chosen, so automatic title generation never overwrites it.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.annotate({ description: "The new title, used as given." }),
  }),
  success: Schema.Struct({ title: Schema.String }),
  failure: ThreadRenameFailedError,
  dependencies: [McpInvocationContext, OrchestrationEngineService, Crypto.Crypto],
})
  .annotate(Tool.Title, "Rename thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadToolkit = Toolkit.make(RenameThreadTool);

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer({
  rename_thread: ({ title }) =>
    Effect.gen(function* () {
      const { threadId } = yield* McpInvocationContext;
      const engine = yield* OrchestrationEngineService;
      const crypto = yield* Crypto.Crypto;
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`server:mcp-thread-rename:${threadId}:${uuid}`),
          threadId,
          title,
        })
        .pipe(Effect.mapError((cause) => new ThreadRenameFailedError({ cause })));
      return { title };
    }),
});
