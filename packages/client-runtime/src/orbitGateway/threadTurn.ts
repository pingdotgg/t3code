import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { deriveThreadTitleSeed } from "../operations/threadTitle.ts";
import type { OrbitModelFallback, OrbitThreadStart } from "./threadStart.ts";

/**
 * Conn: the launch that starts a thread in a clone with its first message, in the clone's
 * workspace project (Orbit's docs/cli/instance/container/thread.mmd). It reuses the start's
 * command id, so a repeated launch finishes the first one on the server instead of failing on the
 * thread it created. The model and modes the start carries win over the clone's defaults.
 */
export function orbitFirstTurnInput(input: {
  readonly start: OrbitThreadStart;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}) {
  const title = deriveThreadTitleSeed({ text: input.start.message, attachments: [] });
  const modelSelection = input.start.modelSelection ?? input.modelSelection;
  const runtimeMode = input.start.runtimeMode ?? "full-access";
  const interactionMode = input.start.interactionMode ?? "default";
  return {
    commandId: CommandId.make(input.start.commandId),
    threadId: ThreadId.make(input.start.threadId),
    message: {
      messageId: MessageId.make(input.start.messageId),
      role: "user" as const,
      text: input.start.message,
      attachments: [],
    },
    modelSelection,
    titleSeed: title,
    runtimeMode,
    interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  };
}

export interface OrbitFirstMessagePorts {
  /** The clone's workspace project and its server's model, or null when they did not load in time. */
  readonly waitForClone: (environmentId: string) => Promise<{
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection | null;
    /** Whether the clone's server offers a model's provider; without it every model counts. */
    readonly offers?: (selection: ModelSelection) => boolean;
  } | null>;
  /** Runs the launch; resolves the failure when the server did not take it. */
  readonly startTurn: (
    environmentId: string,
    input: ReturnType<typeof orbitFirstTurnInput>,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>;
  readonly now: () => string;
  /** True once the start was dismissed; no launch goes out then. */
  readonly stopped: () => boolean;
  /** The clone lacks the start's provider: the first turn uses the clone's default instead. */
  readonly onModelFallback?: (fallback: OrbitModelFallback) => void;
}

/** Sends the first message; resolves its clone project. Only a launch the server took counts. */
export async function sendOrbitFirstMessage(
  start: OrbitThreadStart & { readonly environmentId: string },
  ports: OrbitFirstMessagePorts,
): Promise<ProjectId> {
  const clone = await ports.waitForClone(start.environmentId);
  if (clone === null) throw new Error("The clone's Conn project /srv/workspace did not appear.");
  const requested = start.modelSelection ?? null;
  const fallBack = requested !== null && clone.offers !== undefined && !clone.offers(requested);
  const modelSelection = fallBack ? clone.modelSelection : (requested ?? clone.modelSelection);
  if (modelSelection === null) throw new Error("The clone's Conn Server offers no model.");
  if (fallBack) {
    ports.onModelFallback?.({ requestedModel: requested.model, usedModel: modelSelection.model });
  }
  if (ports.stopped()) throw new Error("The thread start was stopped.");
  const result = await ports.startTurn(
    start.environmentId,
    orbitFirstTurnInput({
      start: fallBack ? { ...start, modelSelection } : start,
      projectId: clone.projectId,
      modelSelection,
      createdAt: ports.now(),
    }),
  );
  if (!result.ok) {
    const error = result.error;
    throw new Error(
      `The clone did not take the first message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return clone.projectId;
}
