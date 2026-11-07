import {
  type CommandId,
  type GitActionProgressPhase,
  type GitStackedAction,
  MessageId,
  type OrchestrationV2Notification,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";

const ACTION_LABEL: Record<GitStackedAction, string> = {
  commit: "Commit",
  push: "Push",
  create_pr: "Create pull request",
  commit_push: "Commit & push",
  commit_push_pr: "Commit, push & PR",
};

const PHASE_LABEL: Record<GitActionProgressPhase, string> = {
  branch: "creating the branch",
  commit: "committing",
  push: "pushing",
  pr: "creating the pull request",
};

export function gitActionFailureMessage(input: {
  readonly action: GitStackedAction;
  readonly phase: GitActionProgressPhase | null;
  readonly detail: string;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const actionLabel = ACTION_LABEL[input.action];
  const during = input.phase === null ? "" : ` while ${PHASE_LABEL[input.phase] ?? input.phase}`;
  const detail = input.detail.trim() || "Source control action failed.";
  return {
    text: [
      `The ${actionLabel} action failed${during}:`,
      "",
      detail,
      "",
      "Fix the issue and retry the action.",
    ].join("\n"),
    notification: {
      source: { kind: "system" },
      outcome: "failed",
      summary: `${actionLabel} failed`,
    },
  };
}

/**
 * Never fails the caller: the stacked action already failed and the client is getting that error,
 * so a wake that cannot be made is logged and dropped. Callers must require orchestration-operate;
 * source-control write alone must not reach this path.
 */
export const sendGitActionFailureToAgent: <E>(input: {
  readonly threadId: ThreadId;
  readonly action: GitStackedAction;
  readonly phase: GitActionProgressPhase | null;
  readonly detail: string;
  readonly commandId: Effect.Effect<CommandId, E>;
}) => Effect.Effect<
  void,
  never,
  Orchestrator.OrchestratorV2 | ServerSettings.ServerSettingsService | SecureRandom.SecureRandom
> = Effect.fn("sendGitActionFailureToAgent")(
  function* <E>(input: {
    readonly threadId: ThreadId;
    readonly action: GitStackedAction;
    readonly phase: GitActionProgressPhase | null;
    readonly detail: string;
    readonly commandId: Effect.Effect<CommandId, E>;
  }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    if (!(yield* settings.getSettings).sendGitActionFailuresToAgent) return;

    const engine = yield* Orchestrator.OrchestratorV2;
    const thread = yield* engine
      .getThreadShell(input.threadId)
      .pipe(Effect.map(Option.fromNullishOr));
    if (Option.isNone(thread)) return;

    const random = yield* SecureRandom.SecureRandom;
    const uuid = yield* random.uuidV4();
    const commandId = yield* input.commandId;
    const wake = gitActionFailureMessage(input);
    yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId,
        threadId: input.threadId,
        messageId: MessageId.make(`message:git-action-failure:${uuid}`),
        text: wake.text,
        notification: wake.notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.asVoid);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("failed to send git action failure to agent", {
              threadId: input.threadId,
            }),
      ),
    ),
);
