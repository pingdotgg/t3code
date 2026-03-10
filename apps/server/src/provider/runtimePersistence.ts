import {
  IsoDateTime,
  ProviderStartOptions,
  type ProviderRuntimeEvent,
  type ProviderSession,
  TurnId,
} from "@t3tools/contracts";
import { Schema } from "effect";

import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";

const NullableString = Schema.NullOr(Schema.String);

const PersistedProviderRuntimePayloadSchema = Schema.Struct({
  cwd: Schema.optional(NullableString),
  model: Schema.optional(NullableString),
  providerOptions: Schema.optional(Schema.NullOr(ProviderStartOptions)),
  activeTurnId: Schema.optional(Schema.NullOr(TurnId)),
  lastError: Schema.optional(NullableString),
  lastRuntimeEvent: Schema.optional(NullableString),
  lastRuntimeEventAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});

export type PersistedProviderRuntimePayload = typeof PersistedProviderRuntimePayloadSchema.Type;

const decodePersistedPayloadSync = Schema.decodeUnknownSync(PersistedProviderRuntimePayloadSchema);

function withRuntimeEventMetadata(
  payload: PersistedProviderRuntimePayload,
  event: ProviderRuntimeEvent,
): PersistedProviderRuntimePayload {
  return {
    ...payload,
    lastRuntimeEvent: event.type,
    lastRuntimeEventAt: event.createdAt,
  };
}

function runtimeTurnState(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (event.payload.state) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return event.payload.state;
    default:
      return "completed";
  }
}

function shouldAdoptTurnFromEventType(type: ProviderRuntimeEvent["type"]): boolean {
  switch (type) {
    case "content.delta":
    case "item.started":
    case "item.updated":
    case "item.completed":
    case "request.opened":
    case "request.resolved":
    case "user-input.requested":
    case "user-input.resolved":
    case "turn.plan.updated":
    case "turn.proposed.delta":
    case "turn.proposed.completed":
    case "turn.diff.updated":
    case "task.started":
    case "task.progress":
    case "task.completed":
    case "hook.started":
    case "hook.progress":
    case "hook.completed":
    case "tool.progress":
    case "tool.summary":
      return true;
    default:
      return false;
  }
}

export function decodePersistedProviderRuntimePayload(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): PersistedProviderRuntimePayload {
  try {
    return decodePersistedPayloadSync(runtimePayload);
  } catch {
    return {};
  }
}

export function toPersistedRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly providerOptions?: ProviderStartOptions;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): PersistedProviderRuntimePayload {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.providerOptions !== undefined ? { providerOptions: extra.providerOptions } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

export function runtimeBindingPatchFromProviderEvent(
  event: ProviderRuntimeEvent,
  existingBinding?: ProviderRuntimeBinding,
): ProviderRuntimeBinding | undefined {
  const existingPayload = decodePersistedProviderRuntimePayload(existingBinding?.runtimePayload);
  const eventTurnId = event.turnId;

  switch (event.type) {
    case "session.started":
    case "thread.started":
      return {
        threadId: event.threadId,
        provider: event.provider,
        status: "ready",
        ...(event.type === "thread.started" && event.payload.providerThreadId
          ? { resumeCursor: { threadId: event.payload.providerThreadId } }
          : {}),
        runtimePayload: withRuntimeEventMetadata(
          {
            activeTurnId: null,
            lastError: null,
          },
          event,
        ),
      };

    case "session.state.changed":
      const sessionStateRuntimePayload =
        event.payload.state === "error"
          ? { lastError: event.payload.reason ?? existingPayload.lastError ?? null }
          : event.payload.state === "ready"
            ? { lastError: null }
            : {};
      return {
        threadId: event.threadId,
        provider: event.provider,
        status:
          event.payload.state === "starting"
            ? "starting"
            : event.payload.state === "ready"
                ? "ready"
              : event.payload.state === "running" || event.payload.state === "waiting"
                ? "running"
                : event.payload.state === "stopped"
                  ? "stopped"
                  : "error",
        runtimePayload: withRuntimeEventMetadata(
          sessionStateRuntimePayload,
          event,
        ),
      };

    case "turn.started":
      return {
        threadId: event.threadId,
        provider: event.provider,
        status: "running",
        runtimePayload: withRuntimeEventMetadata(
          {
            activeTurnId: eventTurnId ?? existingPayload.activeTurnId ?? null,
            lastError: null,
          },
          event,
        ),
      };

    case "turn.completed":
      return {
        threadId: event.threadId,
        provider: event.provider,
        status: runtimeTurnState(event) === "failed" ? "error" : "ready",
        runtimePayload: withRuntimeEventMetadata(
          {
            activeTurnId: null,
            lastError:
              runtimeTurnState(event) === "failed"
                ? event.payload.errorMessage ?? existingPayload.lastError ?? null
                : null,
          },
          event,
        ),
      };

    case "turn.aborted":
      return {
        threadId: event.threadId,
        provider: event.provider,
        status: "ready",
        runtimePayload: withRuntimeEventMetadata(
          {
            activeTurnId: null,
          },
          event,
        ),
      };

    case "runtime.error":
      return {
        threadId: event.threadId,
        provider: event.provider,
        status: "error",
        runtimePayload: withRuntimeEventMetadata(
          {
            ...(eventTurnId !== undefined ? { activeTurnId: eventTurnId } : {}),
            lastError: event.payload.message ?? existingPayload.lastError ?? null,
          },
          event,
        ),
      };

    case "session.exited":
      return {
        threadId: event.threadId,
        provider: event.provider,
        status: "stopped",
        runtimePayload: withRuntimeEventMetadata(
          {
            activeTurnId: null,
          },
          event,
        ),
      };

    default:
      if (
        eventTurnId !== undefined &&
        existingPayload.activeTurnId == null &&
        shouldAdoptTurnFromEventType(event.type)
      ) {
        return {
          threadId: event.threadId,
          provider: event.provider,
          status: "running",
          runtimePayload: withRuntimeEventMetadata(
            {
              activeTurnId: eventTurnId,
            },
            event,
          ),
        };
      }
      return undefined;
  }
}
