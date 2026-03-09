import type {
  HarnessBinding,
  HarnessConnector,
  HarnessEvent,
  HarnessPendingElicitation,
  HarnessPendingPermission,
  HarnessSession,
  HarnessSnapshot,
} from "@t3tools/contracts";
import { HarnessProfileId } from "@t3tools/contracts";

function upsertById<T extends { readonly id: string }>(
  entries: ReadonlyArray<T>,
  entry: T,
): ReadonlyArray<T> {
  const index = entries.findIndex((existing) => existing.id === entry.id);
  if (index < 0) {
    return [...entries, entry];
  }
  const next = entries.slice();
  next[index] = entry;
  return next;
}

function updateSession(
  sessions: ReadonlyArray<HarnessSession>,
  sessionId: string,
  update: (session: HarnessSession) => HarnessSession,
): ReadonlyArray<HarnessSession> {
  return sessions.map((session) => (session.id === sessionId ? update(session) : session));
}

function removeById<T extends { readonly id: string }>(
  entries: ReadonlyArray<T>,
  id: string,
): ReadonlyArray<T> {
  return entries.filter((entry) => entry.id !== id);
}

export function createEmptyHarnessSnapshot(updatedAt: string): HarnessSnapshot {
  return {
    sequence: 0,
    updatedAt,
    profiles: [],
    sessions: [],
    bindings: [],
    pendingPermissions: [],
    pendingElicitations: [],
    connectors: [],
  };
}

function applyBinding(
  bindings: ReadonlyArray<HarnessBinding>,
  binding: HarnessBinding,
): ReadonlyArray<HarnessBinding> {
  const index = bindings.findIndex((existing) => existing.sessionId === binding.sessionId);
  if (index < 0) {
    return [...bindings, binding];
  }
  const next = bindings.slice();
  next[index] = binding;
  return next;
}

function applyConnector(
  connectors: ReadonlyArray<HarnessConnector>,
  connector: HarnessConnector,
): ReadonlyArray<HarnessConnector> {
  const index = connectors.findIndex((existing) => existing.id === connector.id);
  if (index < 0) {
    return [...connectors, connector];
  }
  const next = connectors.slice();
  next[index] = connector;
  return next;
}

export function projectHarnessEvent(
  snapshot: HarnessSnapshot,
  event: HarnessEvent,
): HarnessSnapshot {
  const nextBase: HarnessSnapshot = {
    ...snapshot,
    sequence: event.sequence,
    updatedAt: event.createdAt,
  };

  switch (event.type) {
    case "session.created": {
      const existing = nextBase.sessions.find((session) => session.id === event.sessionId);
      const session: HarnessSession = existing ?? {
        id: event.sessionId,
        profileId:
          typeof event.payload.profileId === "string"
            ? HarnessProfileId.makeUnsafe(event.payload.profileId)
            : null,
        harness: event.harness,
        adapterKey: event.adapterKey,
        connectionMode: event.connectionMode,
        title: event.payload.title ?? null,
        cwd: event.payload.cwd ?? null,
        model: event.payload.model ?? null,
        mode: event.payload.mode ?? null,
        state: event.payload.state ?? "starting",
        activeTurnId: null,
        nativeSessionId: null,
        lastError: null,
        capabilities: event.payload.capabilities ?? {
          resume: false,
          cancel: false,
          modelSwitch: "unsupported",
          permissions: false,
          elicitation: false,
          toolLifecycle: false,
          reasoningStream: false,
          planStream: false,
          fileArtifacts: false,
          checkpoints: false,
          subagents: false,
        },
        ...(event.payload.metadata ? { metadata: event.payload.metadata } : {}),
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      return {
        ...nextBase,
        sessions: upsertById(nextBase.sessions, session),
      };
    }

    case "session.bound":
      return {
        ...nextBase,
        bindings: applyBinding(nextBase.bindings, event.payload.binding),
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          nativeSessionId: event.payload.binding.nativeSessionId ?? session.nativeSessionId,
          updatedAt: event.createdAt,
        })),
      };

    case "session.state.changed":
      return {
        ...nextBase,
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          state: event.payload.state,
          lastError:
            event.payload.state === "error" ? (event.payload.reason ?? session.lastError) : session.lastError,
          updatedAt: event.createdAt,
        })),
      };

    case "session.config.changed":
      return {
        ...nextBase,
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.cwd !== undefined ? { cwd: event.payload.cwd } : {}),
          ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
          ...(event.payload.mode !== undefined ? { mode: event.payload.mode } : {}),
          ...(event.payload.metadata !== undefined ? { metadata: event.payload.metadata } : {}),
          updatedAt: event.createdAt,
        })),
      };

    case "session.capabilities.changed":
      return {
        ...nextBase,
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          capabilities: event.payload.capabilities,
          updatedAt: event.createdAt,
        })),
      };

    case "session.exited":
      return {
        ...nextBase,
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          state: event.payload.recoverable === false ? "stopped" : session.state,
          lastError: event.payload.reason ?? session.lastError,
          activeTurnId: null,
          updatedAt: event.createdAt,
        })),
      };

    case "turn.started":
      return {
        ...nextBase,
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          state: "running",
          activeTurnId: event.turnId ?? session.activeTurnId,
          updatedAt: event.createdAt,
        })),
      };

    case "turn.completed":
      return {
        ...nextBase,
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          state: "ready",
          activeTurnId: null,
          updatedAt: event.createdAt,
        })),
      };

    case "turn.failed":
      return {
        ...nextBase,
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          state: "error",
          activeTurnId: null,
          lastError: event.payload.message,
          updatedAt: event.createdAt,
        })),
      };

    case "turn.cancelled":
      return {
        ...nextBase,
        sessions: updateSession(nextBase.sessions, event.sessionId, (session) => ({
          ...session,
          state: "ready",
          activeTurnId: null,
          updatedAt: event.createdAt,
        })),
      };

    case "permission.requested": {
      const pending: HarnessPendingPermission = {
        id: event.payload.requestId,
        sessionId: event.sessionId,
        turnId: event.turnId ?? null,
        kind: event.payload.kind,
        title: event.payload.title,
        ...(event.payload.detail ? { detail: event.payload.detail } : {}),
        ...(event.payload.args !== undefined ? { args: event.payload.args } : {}),
        createdAt: event.createdAt,
      };
      return {
        ...nextBase,
        pendingPermissions: upsertById(nextBase.pendingPermissions, pending),
      };
    }

    case "permission.resolved":
      return {
        ...nextBase,
        pendingPermissions: removeById(nextBase.pendingPermissions, event.payload.requestId),
      };

    case "elicitation.requested": {
      const pending: HarnessPendingElicitation = {
        id: event.payload.requestId,
        sessionId: event.sessionId,
        turnId: event.turnId ?? null,
        questions: event.payload.questions,
        createdAt: event.createdAt,
      };
      return {
        ...nextBase,
        pendingElicitations: upsertById(nextBase.pendingElicitations, pending),
      };
    }

    case "elicitation.resolved":
      return {
        ...nextBase,
        pendingElicitations: removeById(nextBase.pendingElicitations, event.payload.requestId),
      };

    case "connector.connected":
    case "connector.disconnected":
      return {
        ...nextBase,
        connectors: applyConnector(nextBase.connectors, {
          id: event.payload.connectorId,
          profileId: null,
          harness: event.harness,
          adapterKey: event.adapterKey,
          health: event.type === "connector.connected" ? "connected" : "disconnected",
          ...(event.payload.description ? { description: event.payload.description } : {}),
          ...(event.payload.version ? { version: event.payload.version } : {}),
          lastSeenAt: event.createdAt,
          ...(event.payload.metadata ? { metadata: event.payload.metadata } : {}),
        }),
      };

    case "connector.health.changed":
      return {
        ...nextBase,
        connectors: applyConnector(nextBase.connectors, {
          id: event.payload.connectorId,
          profileId: null,
          harness: event.harness,
          adapterKey: event.adapterKey,
          health: event.payload.health,
          ...(event.payload.detail ? { description: event.payload.detail } : {}),
          lastSeenAt: event.createdAt,
        }),
      };

    default:
      return nextBase;
  }
}
