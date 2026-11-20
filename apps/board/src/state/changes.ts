import { createReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/review";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createVcsActionManager } from "@t3tools/client-runtime/state/vcs";
import {
  type EnvironmentId,
  type GitRunStackedActionResult,
  type GitStackedAction,
  MessageId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { failureText } from "../settings/failureText";
import { newId } from "./boards";
import { type DiffSource } from "./filesView";
import { previewInput } from "./changesView";
import { environmentThreads, startTurn } from "./threads";

export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime);
const readDiffPatch = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:changes:diff-patch",
  tag: WS_METHODS.reviewGetDiffPreview,
});

/**
 * One file's patch of a diff source. T3 caps a whole diff's patch at 120 KB and a single file's at
 * 1 MB, so a large diff is read a file at a time. Resolves to the patch text, which is empty when
 * the file is no longer part of the diff.
 */
export async function loadFilePatch(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  cwd: string,
  diff: DiffSource,
  ignoreWhitespace: boolean,
  file: { readonly path: string; readonly previousPath: string | null },
): Promise<string> {
  const result = await runAtomCommand(
    registry,
    readDiffPatch,
    {
      environmentId,
      input: {
        ...previewInput(cwd, diff, ignoreWhitespace),
        file: { path: file.path, previousPath: file.previousPath, sourceKind: diff.kind },
      },
    },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw new Error(failureText(result));
  return result.value.sources.find((source) => source.kind === diff.kind)?.diff ?? "";
}

export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

const GIT_FAILED = "Source control action failed.";

/**
 * Runs one of T3's stacked git actions in a checkout, which commits everything changed. With no
 * message T3 writes one. Resolves to the result, or to the engine's own reason for the failure.
 */
export async function runGitAction(
  registry: AtomRegistry.AtomRegistry,
  target: { readonly environmentId: EnvironmentId; readonly cwd: string },
  action: GitStackedAction,
  commitMessage: string,
): Promise<
  | { readonly ok: true; readonly result: GitRunStackedActionResult }
  | { readonly ok: false; readonly message: string }
> {
  let reason: string | null = null;
  const result = await runAtomCommand(
    registry,
    vcsActionManager.runStackedAction(target),
    {
      actionId: newId(),
      action,
      ...(commitMessage === "" ? {} : { commitMessage }),
      onProgress: (event) => {
        if (event.kind === "action_failed") reason = event.message;
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") return { ok: true, result: result.value };
  return { ok: false, message: reason ?? (failureText(result) || GIT_FAILED) };
}

/** Messages the board's orchestrator as the user would. Resolves to the failure text, or null once sent. */
export async function tellOrchestrator(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  orchestratorThreadId: string | null,
  text: string,
): Promise<string | null> {
  if (orchestratorThreadId === null) return "Start this board's orchestrator first.";
  const threadId = ThreadId.make(orchestratorThreadId);
  const { data } = AsyncResult.getOrElse(
    registry.get(environmentThreads.stateAtom(environmentId, threadId)),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  );
  const projection = Option.getOrNull(data);
  if (projection === null) return "The orchestrator has not loaded yet. Try again in a moment.";
  const result = await runAtomCommand(
    registry,
    startTurn,
    {
      environmentId,
      input: {
        threadId,
        message: { messageId: MessageId.make(newId()), role: "user", text, attachments: [] },
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
      },
    },
    { reportFailure: false },
  );
  return result._tag === "Success" ? null : failureText(result);
}
