import { OrchestrationGetWorkflowScriptError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { readContainedWorkflowFile } from "./workflowFileRead.ts";

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
}) {
  const file = yield* readContainedWorkflowFile({
    path: input.scriptPath,
    extension: ".js",
    byteCap: 256 * 1024,
  }).pipe(
    Effect.mapError(
      (error) =>
        new OrchestrationGetWorkflowScriptError({
          reason: error.reason === "wrong-extension" ? "not-js" : error.reason,
          scriptPath: error.path,
          cause: error,
        }),
    ),
  );
  return { scriptPath: file.path, contents: file.contents, truncated: file.truncated };
});
