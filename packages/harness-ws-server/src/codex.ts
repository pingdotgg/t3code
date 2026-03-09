import type { HarnessCapabilitySet, HarnessEvent, ProviderRuntimeEvent } from "@t3tools/contracts";
import { HarnessSessionId, RuntimeItemId, RuntimeRequestId, TurnId } from "@t3tools/contracts";

export const CODEX_HARNESS_CAPABILITIES: HarnessCapabilitySet = {
  resume: true,
  cancel: true,
  modelSwitch: "restart-required",
  permissions: true,
  elicitation: true,
  toolLifecycle: true,
  reasoningStream: true,
  planStream: true,
  fileArtifacts: true,
  checkpoints: true,
  subagents: true,
};

interface CodexMapOptions {
  readonly sequenceStart?: number;
  readonly adapterKey?: string;
}

type RuntimePlanStep = Extract<
  ProviderRuntimeEvent,
  { readonly type: "turn.plan.updated" }
>["payload"]["plan"][number];
type RuntimeQuestion = Extract<
  ProviderRuntimeEvent,
  { readonly type: "user-input.requested" }
>["payload"]["questions"][number];
type PersistedFile = Extract<
  ProviderRuntimeEvent,
  { readonly type: "files.persisted" }
>["payload"]["files"][number];

function harnessSessionIdFromRuntimeEvent(event: ProviderRuntimeEvent) {
  return HarnessSessionId.makeUnsafe(String(event.threadId));
}

function itemIdFromRuntimeEvent(event: ProviderRuntimeEvent): RuntimeItemId | undefined {
  return event.itemId ? RuntimeItemId.makeUnsafe(String(event.itemId)) : undefined;
}

function turnIdFromRuntimeEvent(event: ProviderRuntimeEvent): TurnId | undefined {
  return event.turnId ? TurnId.makeUnsafe(String(event.turnId)) : undefined;
}

function requestIdFromRuntimeEvent(event: ProviderRuntimeEvent): RuntimeRequestId | undefined {
  return event.requestId ? RuntimeRequestId.makeUnsafe(String(event.requestId)) : undefined;
}

function eventBase(
  event: ProviderRuntimeEvent,
  sequence: number,
  adapterKey: string,
): Omit<HarnessEvent, "type" | "payload"> {
  return {
    eventId: event.eventId,
    sessionId: harnessSessionIdFromRuntimeEvent(event),
    createdAt: event.createdAt,
    sequence,
    harness: "codex-app-server",
    adapterKey,
    connectionMode: "spawned",
    ...(event.turnId ? { turnId: turnIdFromRuntimeEvent(event) } : {}),
    ...(event.itemId ? { itemId: itemIdFromRuntimeEvent(event) } : {}),
    ...(event.raw ? { nativeRefs: { source: event.raw.source } } : {}),
  };
}

function withNativeFrame(
  event: ProviderRuntimeEvent,
  sequence: number,
  adapterKey: string,
): HarnessEvent | undefined {
  if (!event.raw) {
    return undefined;
  }
  return {
    ...eventBase(event, sequence, adapterKey),
    type: "native.frame",
    payload: {
      source: event.raw.source,
      payload: event.raw.payload,
    },
  } as HarnessEvent;
}

export function mapCodexProviderRuntimeEventToHarnessEvents(
  event: ProviderRuntimeEvent,
  options?: CodexMapOptions,
): ReadonlyArray<HarnessEvent> {
  const start = options?.sequenceStart ?? 1;
  const adapterKey = options?.adapterKey ?? "codex-runtime-compat";
  let nextSequence = start;
  const events: HarnessEvent[] = [];
  const push = (mapped: HarnessEvent | undefined) => {
    if (mapped) {
      events.push(mapped);
      nextSequence += 1;
    }
  };

  switch (event.type) {
    case "session.started":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "session.created",
        payload: {
          state: "starting",
          capabilities: CODEX_HARNESS_CAPABILITIES,
          ...(event.payload.message ? { title: event.payload.message } : {}),
          ...(event.payload.resume !== undefined ? { metadata: { resume: event.payload.resume } } : {}),
        },
      } as HarnessEvent);
      break;

    case "session.configured":
      {
        const config = event.payload.config as Record<string, unknown>;
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "session.config.changed",
        payload: {
          ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
          ...(typeof config.model === "string" ? { model: config.model } : {}),
          ...(typeof config.mode === "string" ? { mode: config.mode } : {}),
          metadata: config,
        },
      } as HarnessEvent);
      }
      break;

    case "session.state.changed":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "session.state.changed",
        payload: {
          state:
            event.payload.state === "waiting"
              ? "waiting"
              : event.payload.state === "running"
                ? "running"
                : event.payload.state === "starting"
                  ? "starting"
                  : event.payload.state === "error"
                    ? "error"
                    : event.payload.state === "stopped"
                      ? "stopped"
                      : "ready",
          ...(event.payload.reason ? { reason: event.payload.reason } : {}),
        },
      } as HarnessEvent);
      break;

    case "session.exited":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "session.exited",
        payload: {
          ...(event.payload.reason ? { reason: event.payload.reason } : {}),
          ...(event.payload.recoverable !== undefined
            ? { recoverable: event.payload.recoverable }
            : {}),
        },
      } as HarnessEvent);
      break;

    case "turn.started":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "turn.started",
        payload: event.payload.model ? { model: event.payload.model } : {},
      } as HarnessEvent);
      break;

    case "turn.completed": {
      const state = event.payload.state;
      if (state === "failed") {
        push({
          ...eventBase(event, nextSequence, adapterKey),
          type: "turn.failed",
          payload: {
            message: event.payload.errorMessage ?? "Codex turn failed",
            ...(event.payload.usage !== undefined ? { detail: event.payload.usage } : {}),
          },
        } as HarnessEvent);
      } else if (state === "cancelled") {
        push({
          ...eventBase(event, nextSequence, adapterKey),
          type: "turn.cancelled",
          payload: event.payload.stopReason ? { reason: event.payload.stopReason } : {},
        } as HarnessEvent);
      } else {
        push({
          ...eventBase(event, nextSequence, adapterKey),
          type: "turn.completed",
          payload: {
            ...(event.payload.stopReason ? { stopReason: event.payload.stopReason } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
        } as HarnessEvent);
      }
      break;
    }

    case "turn.plan.updated":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "plan.updated",
        payload: {
          ...(event.payload.explanation ? { explanation: event.payload.explanation } : {}),
          steps: event.payload.plan.map((step: RuntimePlanStep) => ({
            step: step.step,
            status:
              step.status === "inProgress"
                ? "in-progress"
                : step.status === "completed"
                  ? "completed"
                  : "pending",
          })),
        },
      } as HarnessEvent);
      break;

    case "turn.proposed.delta":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "plan.delta",
        payload: {
          delta: event.payload.delta,
        },
      } as HarnessEvent);
      break;

    case "turn.proposed.completed":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "plan.completed",
        payload: {
          planMarkdown: event.payload.planMarkdown,
        },
      } as HarnessEvent);
      break;

    case "content.delta":
      if (event.payload.streamKind === "assistant_text") {
        push({
          ...eventBase(event, nextSequence, adapterKey),
          type: "message.delta",
          payload: {
            role: "assistant",
            stream: "assistant",
            delta: event.payload.delta,
          },
        } as HarnessEvent);
      } else if (event.payload.streamKind === "reasoning_text") {
        push({
          ...eventBase(event, nextSequence, adapterKey),
          type: "reasoning.delta",
          payload: {
            delta: event.payload.delta,
          },
        } as HarnessEvent);
      } else if (event.payload.streamKind === "reasoning_summary_text") {
        push({
          ...eventBase(event, nextSequence, adapterKey),
          type: "reasoning.summary",
          payload: {
            text: event.payload.delta.trim() || "Reasoning summary",
          },
        } as HarnessEvent);
      } else if (event.payload.streamKind === "plan_text") {
        push({
          ...eventBase(event, nextSequence, adapterKey),
          type: "plan.delta",
          payload: {
            delta: event.payload.delta,
          },
        } as HarnessEvent);
      }
      break;

    case "item.started":
    case "item.updated":
    case "item.completed":
      push({
        ...eventBase(
          event,
          nextSequence,
          adapterKey,
        ),
        type:
          event.type === "item.started"
            ? "item.started"
            : event.type === "item.updated"
              ? "item.updated"
              : "item.completed",
        payload: {
          itemType: event.payload.itemType,
          ...(event.payload.title ? { title: event.payload.title } : {}),
          ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          ...(event.payload.status ? { status: event.payload.status } : {}),
          ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
        },
      } as HarnessEvent);
      break;

    case "request.opened": {
      const requestId = requestIdFromRuntimeEvent(event);
      if (!requestId) break;
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "permission.requested",
        payload: {
          requestId,
          kind:
            event.payload.requestType === "file_read_approval"
              ? "file-read"
              : event.payload.requestType === "file_change_approval" ||
                  event.payload.requestType === "apply_patch_approval"
                ? "file-change"
                : event.payload.requestType === "exec_command_approval" ||
                    event.payload.requestType === "command_execution_approval"
                  ? "exec"
                  : "other",
          title: event.payload.detail ?? event.payload.requestType,
          ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          ...(event.payload.args !== undefined ? { args: event.payload.args } : {}),
        },
      } as HarnessEvent);
      break;
    }

    case "request.resolved": {
      const requestId = requestIdFromRuntimeEvent(event);
      if (!requestId) break;
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "permission.resolved",
        payload: {
          requestId,
          decision:
            event.payload.decision === "acceptForSession"
              ? "accept-for-session"
              : event.payload.decision === "accept"
                ? "accept"
                : event.payload.decision === "cancel"
                  ? "cancel"
                  : "decline",
          ...(event.payload.decision ? { detail: event.payload.decision } : {}),
        },
      } as HarnessEvent);
      break;
    }

    case "user-input.requested": {
      const requestId = requestIdFromRuntimeEvent(event);
      if (!requestId) break;
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "elicitation.requested",
        payload: {
          requestId,
          questions: event.payload.questions.map((question: RuntimeQuestion) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options,
          })),
        },
      } as HarnessEvent);
      break;
    }

    case "user-input.resolved": {
      const requestId = requestIdFromRuntimeEvent(event);
      if (!requestId) break;
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "elicitation.resolved",
        payload: {
          requestId,
          answers: Object.values(event.payload.answers).map((value) =>
            Array.isArray(value) ? value.map(String) : [String(value)],
          ),
        },
      } as HarnessEvent);
      break;
    }

    case "files.persisted":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "artifact.persisted",
        payload: {
          files: event.payload.files.map((file: PersistedFile) => ({
            id: file.fileId,
            path: file.filename,
            kind: "file",
          })),
        },
      } as HarnessEvent);
      break;

    case "runtime.warning":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "transport.warning",
        payload: {
          message: event.payload.message,
          ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
        },
      } as HarnessEvent);
      break;

    case "runtime.error":
      push({
        ...eventBase(event, nextSequence, adapterKey),
        type: "transport.error",
        payload: {
          message: event.payload.message,
          ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
        },
      } as HarnessEvent);
      break;

    default:
      break;
  }

  push(withNativeFrame(event, nextSequence, adapterKey));
  return events;
}
