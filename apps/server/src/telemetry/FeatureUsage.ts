import {
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { quizAnswerGrade } from "@t3tools/shared/quizCard";

export interface FeatureUsage {
  readonly feature: string;
  readonly variant?: string;
}

type Payload = Readonly<Record<string, unknown>>;

const literal = (payload: Payload, key: string) =>
  typeof payload[key] === "string" ? (payload[key] as string) : undefined;

const use = (feature: string, variant?: string): FeatureUsage =>
  variant === undefined ? { feature } : { feature, variant };

/**
 * Exclude housekeeping. `client.turn.requested` counts every `message.dispatch`; only sending a
 * guest's message is also a feature. Record at command dispatch so retries do not count twice.
 */
const COMMAND_FEATURES: {
  readonly [Type in OrchestrationV2Command["type"]]?: (
    command: Extract<OrchestrationV2Command, { readonly type: Type }>,
  ) => FeatureUsage | undefined;
} = {
  "message.dispatch": (command) => {
    if (command.guestMessageId !== undefined) return { feature: "guest_message.send" };
    const grade = quizAnswerGrade(command.text);
    return grade === undefined ? undefined : use("quiz.answer", grade);
  },
  "checkpoint.rollback": (command) => ({
    feature: "checkpoint.rollback",
    variant: command.restoreFiles === false ? "conversation_only" : "with_files",
  }),
  "thread.fork": () => ({ feature: "thread.fork" }),
  "thread.merge_back": () => ({ feature: "thread.merge_back" }),
  "provider.switch": () => ({ feature: "provider.switch" }),
  "thread.archive": () => ({ feature: "thread.archive" }),
  "thread.snooze": () => ({ feature: "thread.snooze" }),
  "thread.pin": () => ({ feature: "thread.pin" }),
  "thread.settle": () => ({ feature: "thread.settle" }),
  "thread.pull-request.link": () => ({ feature: "thread.pull_request.link" }),
  "thread.pull-request.watch": (command) =>
    use("thread.pull_request.watch", command.watching ? "on" : "off"),
  "thread.runtime-mode.set": (command) => use("thread.runtime_mode.set", command.runtimeMode),
  "thread.interaction-mode.set": (command) =>
    use("thread.interaction_mode.set", command.interactionMode),
  "run.interrupt": () => ({ feature: "run.interrupt" }),
  "queued-message.promote-to-steer": () => ({ feature: "queue.steer" }),
  "queued-run.edit": () => ({ feature: "queue.edit" }),
  "thread.guest-share.close": () => ({ feature: "guest_share.close" }),
  "thread.guest-message.dismiss": () => ({ feature: "guest_message.dismiss" }),
  "thread.side_chat.open": () => ({ feature: "side_chat.open" }),
  "thread.side_chat.done": (command) =>
    use("side_chat.finish", command.discard === true ? "discard" : "done"),
};

/**
 * RPCs that represent a user starting a feature. Variants come only from
 * closed enums in the contracts, so no path, id, or free text can reach analytics.
 * Thread launches are left out because `client.thread.started` counts them.
 */
const METHOD_FEATURES: Readonly<Record<string, (payload: Payload) => FeatureUsage>> = {
  [WS_METHODS.terminalOpen]: () => ({ feature: "terminal.open" }),
  [WS_METHODS.previewOpen]: () => ({ feature: "preview.open" }),
  [WS_METHODS.deviceOpen]: () => ({ feature: "device.open" }),
  [WS_METHODS.shellOpenInEditor]: (payload) => use("editor.open", literal(payload, "editor")),
  [WS_METHODS.vcsCreateWorktree]: () => ({ feature: "worktree.create" }),
  [WS_METHODS.gitRunStackedAction]: (payload) =>
    use("git.stacked_action", literal(payload, "action")),
  [WS_METHODS.pullRequestsRunAction]: (payload) =>
    use("pull_request.action", literal(payload, "action")),
  [WS_METHODS.pullRequestsSubmitReview]: () => ({ feature: "pull_request.review" }),
  [WS_METHODS.pullRequestsComment]: () => ({ feature: "pull_request.comment" }),
  [WS_METHODS.scheduledTasksUpsert]: () => ({ feature: "scheduled_task.save" }),
  [WS_METHODS.scheduledTasksRunNow]: () => ({ feature: "scheduled_task.run_now" }),
  [WS_METHODS.agentSessionsImport]: () => ({ feature: "agent_session.import" }),
  [WS_METHODS.projectCloneStart]: () => ({ feature: "project.clone" }),
  [WS_METHODS.sourceControlPublishRepository]: () => ({ feature: "repository.publish" }),
  [WS_METHODS.sourceControlSignInStart]: () => ({ feature: "source_control.sign_in" }),
  [WS_METHODS.serverUpsertKeybinding]: () => ({ feature: "keybinding.customize" }),
  [WS_METHODS.guestShareCreate]: () => ({ feature: "guest_share.create" }),
  [WS_METHODS.lessonCreate]: (payload) =>
    use("lesson.create", payload.projectId === undefined ? "new_project" : "in_project"),
  [WS_METHODS.knowledgeRemove]: () => ({ feature: "knowledge_map.remove" }),
  [WS_METHODS.coursesRemove]: () => ({ feature: "course.remove" }),
  [WS_METHODS.learnFeatureUsed]: (payload) =>
    use(payload.feature as string, literal(payload, "variant")),
};

/** The feature a dispatched command uses, or undefined when it is not a tracked feature. */
export function commandFeatureUsage(command: OrchestrationV2Command): FeatureUsage | undefined {
  // TypeScript cannot pair a union's tag with its own entry, so widen once here.
  const mapping = COMMAND_FEATURES[command.type] as
    | ((command: OrchestrationV2Command) => FeatureUsage | undefined)
    | undefined;
  return mapping?.(command);
}

/** The feature a WebSocket request uses, or undefined when it is not a tracked feature. */
export function featureUsage(method: string, payload: unknown): FeatureUsage | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  return METHOD_FEATURES[method]?.(payload as Payload);
}

/**
 * Side chats a sent message finished by itself (auto-finish), read from the events it committed.
 * The Orchestrator stays free of analytics; Done and Discard are counted as their own command.
 */
export function autoFinishedSideChats(
  command: OrchestrationV2Command,
  storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
): number {
  if (command.type !== "message.dispatch") return 0;
  return storedEvents.filter(
    ({ event }) =>
      event.type === "thread.metadata-updated" &&
      event.payload.sideChat?.done?.outcome.status === "generating",
  ).length;
}
