import type { TaskIntakeMessage, TaskIntakeResolution } from "./contracts.ts";
import { decodeTaskIntakeMessage } from "./contracts.ts";
import type { TaskIntakeReplyTransport, TaskIntakeRuntime, TaskIntakeStore } from "./ports.ts";
import { toTaskIntakeExternalLinkIdentity } from "../domain/taskIntakeExternalLink.ts";
import { buildTaskIntakeInitialPrompt, buildTaskIntakeTitle } from "./prompts.ts";
import {
  buildTaskIntakeAcceptedReply,
  buildTaskIntakeFollowUpReply,
  buildTaskIntakeNeedsInputReply,
  buildTaskIntakeStartFailedReply,
} from "./replies.ts";

export type TaskIntakeIngressResult =
  | {
      readonly accepted: true;
      readonly ignored: true;
      readonly resolution: TaskIntakeResolution;
      readonly reason: string;
      readonly taskId?: string;
      readonly t3ThreadId?: string;
    }
  | {
      readonly accepted: true;
      readonly ignored: false;
      readonly resolution: TaskIntakeResolution;
      readonly taskId?: string;
      readonly t3ThreadId?: string;
    };

export interface TaskIntakeIngressDependencies {
  readonly store: TaskIntakeStore;
  readonly runtime: TaskIntakeRuntime;
  readonly replies: TaskIntakeReplyTransport;
}

function clarifyReason(message: TaskIntakeMessage): string | null {
  const text = message.text.trim();
  if (text.length === 0) {
    return "The message did not include a coding request.";
  }

  const withoutMentions = text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/@\S+/g, "")
    .trim();
  if (withoutMentions.length < 8) {
    return "The message only included a mention or very short note.";
  }

  return null;
}

function errorSummary(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function postReplyBestEffort(
  dependencies: TaskIntakeIngressDependencies,
  reply: Parameters<TaskIntakeIngressDependencies["replies"]["postReply"]>[0],
) {
  try {
    await dependencies.replies.postReply(reply);
  } catch {
    // Source replies are useful but should not change Task/runtime state.
  }
}

export async function handleTaskIntakeMessage(
  rawMessage: unknown,
  dependencies: TaskIntakeIngressDependencies,
): Promise<TaskIntakeIngressResult> {
  const message = decodeTaskIntakeMessage(rawMessage);
  const externalLink = toTaskIntakeExternalLinkIdentity(message.conversation);
  const ambiguousReason = clarifyReason(message);

  if (ambiguousReason !== null) {
    const reply = buildTaskIntakeNeedsInputReply({ message, reason: ambiguousReason });
    await postReplyBestEffort(dependencies, reply);
    return {
      accepted: true,
      ignored: false,
      resolution: {
        type: "needs_input",
        reason: ambiguousReason,
        reply,
      },
    };
  }

  const stored = await dependencies.store.resolveMessage({
    message,
    externalLink,
    title: buildTaskIntakeTitle(message),
  });

  if (stored.status === "duplicate") {
    return {
      accepted: true,
      ignored: true,
      reason: "duplicate_event",
      resolution: {
        type: "ignore",
        reason: "duplicate_event",
      },
    };
  }

  if (stored.status === "routed_existing") {
    const reply = buildTaskIntakeFollowUpReply({
      message,
      taskId: stored.taskId,
      ...(stored.t3ThreadId !== undefined ? { t3ThreadId: stored.t3ThreadId } : {}),
    });
    await postReplyBestEffort(dependencies, reply);
    return {
      accepted: true,
      ignored: false,
      taskId: stored.taskId,
      ...(stored.t3ThreadId !== undefined ? { t3ThreadId: stored.t3ThreadId } : {}),
      resolution: {
        type: "route_existing_task",
        taskId: stored.taskId,
      },
    };
  }

  try {
    const materialized = await dependencies.runtime.materializeTaskRuntime({
      taskId: stored.taskId,
      initialPrompt: buildTaskIntakeInitialPrompt(message),
      startCodingAgent: true,
    });
    await postReplyBestEffort(
      dependencies,
      buildTaskIntakeAcceptedReply({
        message,
        taskId: stored.taskId,
        t3ThreadId: materialized.t3ThreadId,
        branch: materialized.branch,
      }),
    );
    return {
      accepted: true,
      ignored: false,
      taskId: stored.taskId,
      t3ThreadId: materialized.t3ThreadId,
      resolution: {
        type: "create_task",
        initialPrompt: buildTaskIntakeInitialPrompt(message),
        title: buildTaskIntakeTitle(message),
      },
    };
  } catch (error) {
    const summary = errorSummary(error);
    await dependencies.store.recordStartFailed({
      message,
      taskId: stored.taskId,
      summary,
    });
    await postReplyBestEffort(
      dependencies,
      buildTaskIntakeStartFailedReply({
        message,
        taskId: stored.taskId,
        summary,
      }),
    );
    return {
      accepted: true,
      ignored: false,
      taskId: stored.taskId,
      resolution: {
        type: "route_existing_task",
        taskId: stored.taskId,
      },
    };
  }
}
