import {
  ProviderInstanceId,
  type ModelSelection,
  type UploadChatAttachment,
} from "@t3tools/contracts";

import type { TaskIntakeMessage, TaskIntakeResolution } from "./contracts.ts";
import { decodeTaskIntakeMessage } from "./contracts.ts";
import type { TaskIntakeReplyTransport, TaskIntakeRuntime, TaskIntakeStore } from "./ports.ts";
import { toTaskIntakeExternalLinkIdentity } from "../domain/taskIntakeExternalLink.ts";
import {
  buildTaskIntakeFollowUpPrompt,
  buildTaskIntakeInitialPrompt,
  buildTaskIntakeTitle,
} from "./prompts.ts";
import { buildTaskIntakeFollowUpFailedReply, buildTaskIntakeStartFailedReply } from "./replies.ts";

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

export interface TaskIntakeIngressOptions {
  readonly initialPromptContext?: string;
}

const CODEX_ROUTING_MARKER = /\[codex\]/i;

const DEFAULT_CHAT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
  options: [{ id: "fastMode", value: true }],
} as const satisfies ModelSelection;

function errorSummary(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withoutCodexRoutingMarker(text: string) {
  return text
    .replace(/\[codex\]/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function resolveInitialMessageRouting(message: TaskIntakeMessage): {
  readonly message: TaskIntakeMessage;
  readonly modelSelection: ModelSelection;
} {
  if (!CODEX_ROUTING_MARKER.test(message.text)) {
    return { message, modelSelection: DEFAULT_CHAT_MODEL_SELECTION };
  }

  return {
    message: {
      ...message,
      text: withoutCodexRoutingMarker(message.text),
    },
    modelSelection: DEFAULT_CHAT_MODEL_SELECTION,
  };
}

function nativeImageAttachments(message: TaskIntakeMessage): ReadonlyArray<UploadChatAttachment> {
  return (
    message.attachments
      ?.filter((attachment): attachment is UploadChatAttachment => {
        return "dataUrl" in attachment && attachment.type === "image";
      })
      .map((attachment) => ({
        type: "image" as const,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: attachment.dataUrl,
      })) ?? []
  );
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

async function acknowledgeAcceptedBestEffort(
  dependencies: TaskIntakeIngressDependencies,
  message: TaskIntakeMessage,
) {
  if (dependencies.replies.acknowledgeAccepted === undefined) return;

  try {
    await dependencies.replies.acknowledgeAccepted({ message });
  } catch {
    // Source acknowledgement is useful but should not change Task/runtime state.
  }
}

async function postTaskStartedCardBestEffort(
  dependencies: TaskIntakeIngressDependencies,
  input: Parameters<
    NonNullable<TaskIntakeIngressDependencies["replies"]["postTaskStartedCard"]>
  >[0],
) {
  if (dependencies.replies.postTaskStartedCard === undefined) return;

  try {
    await dependencies.replies.postTaskStartedCard(input);
  } catch {
    // Source status cards are useful but should not change Task/runtime state.
  }
}

export async function handleTaskIntakeMessage(
  rawMessage: unknown,
  dependencies: TaskIntakeIngressDependencies,
  options: TaskIntakeIngressOptions = {},
): Promise<TaskIntakeIngressResult> {
  const message = decodeTaskIntakeMessage(rawMessage);
  const initialRouting = resolveInitialMessageRouting(message);
  const storageMessage = initialRouting.message;
  const externalLink = toTaskIntakeExternalLinkIdentity(message.conversation);

  const stored = await dependencies.store.resolveMessage({
    message: storageMessage,
    externalLink,
    title: buildTaskIntakeTitle(storageMessage),
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
    if (stored.t3ThreadId !== undefined && stored.workSessionId !== undefined) {
      try {
        await dependencies.runtime.continueTaskRuntime({
          eventId: message.eventId,
          taskId: stored.taskId,
          workSessionId: stored.workSessionId,
          t3ThreadId: stored.t3ThreadId,
          prompt: buildTaskIntakeFollowUpPrompt(message),
          attachments: nativeImageAttachments(message),
        });
      } catch (error) {
        const summary = errorSummary(error);
        await postReplyBestEffort(
          dependencies,
          buildTaskIntakeFollowUpFailedReply({
            message,
            taskId: stored.taskId,
            t3ThreadId: stored.t3ThreadId,
            summary,
          }),
        );
        return {
          accepted: true,
          ignored: false,
          taskId: stored.taskId,
          t3ThreadId: stored.t3ThreadId,
          resolution: {
            type: "route_existing_task",
            taskId: stored.taskId,
          },
        };
      }
    }

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
    await acknowledgeAcceptedBestEffort(dependencies, message);
    const initialPrompt =
      options.initialPromptContext === undefined
        ? buildTaskIntakeInitialPrompt(storageMessage)
        : buildTaskIntakeInitialPrompt(storageMessage, { context: options.initialPromptContext });
    const materialized = await dependencies.runtime.materializeTaskRuntime({
      taskId: stored.taskId,
      initialPrompt,
      attachments: nativeImageAttachments(storageMessage),
      startCodingAgent: true,
      modelSelection: initialRouting.modelSelection,
    });
    await postTaskStartedCardBestEffort(dependencies, {
      message,
      taskId: stored.taskId,
      materialization: materialized,
    });
    return {
      accepted: true,
      ignored: false,
      taskId: stored.taskId,
      t3ThreadId: materialized.t3ThreadId,
      resolution: {
        type: "create_task",
        initialPrompt,
        title: buildTaskIntakeTitle(storageMessage),
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
