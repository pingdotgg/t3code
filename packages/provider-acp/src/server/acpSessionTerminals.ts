// ACP session behaviour extracted from server/adapter.ts (sessionTerminals).

import { makeAcpClientTerminals, type AcpClientTerminals } from "./clientTerminals.ts";
import { type AcpAgentTerminalState } from "./runtimeModel.ts";
import { type AcpMcpContext } from "./acpThreadContext.ts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { AcpSessionCtx1 } from "./acpSessionContext.ts";

interface PendingTerminalEnvironment {
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly claimUnknownSession: boolean;
  readonly sessionId: string | null;
}

export const createAcpSessionTerminals = Effect.fn("acpSession.sessionTerminals")(function* (ctx: AcpSessionCtx1) {
  const terminalEnvironmentBySessionId = new Map<string, NodeJS.ProcessEnv>();
  interface PendingTerminalEnvironment {
    readonly environment: NodeJS.ProcessEnv | undefined;
    readonly claimUnknownSession: boolean;
    readonly sessionId: string | null;
  }
  let pendingTerminalEnvironment: PendingTerminalEnvironment | null = {
    environment: (yield* ctx.readMcpContext(ctx.input.threadId)).processEnvironment,
    claimUnknownSession: ctx.input.initialNativeThreadId === undefined,
    sessionId: ctx.input.initialNativeThreadId ?? null,
  };
  const prepareTerminalEnvironment = (
    mcpContext: AcpMcpContext,
    sessionId?: string,
  ): void => {
    pendingTerminalEnvironment = {
      environment: mcpContext.processEnvironment,
      claimUnknownSession: false,
      sessionId: sessionId ?? null,
    };
  };
  const prepareClaimableTerminalEnvironment = (mcpContext: AcpMcpContext): void => {
    pendingTerminalEnvironment = {
      environment: mcpContext.processEnvironment,
      claimUnknownSession: true,
      sessionId: null,
    };
  };
  const rememberTerminalEnvironment = (
    sessionId: string,
    mcpContext: AcpMcpContext,
  ): void => {
    const environment = mcpContext.processEnvironment;
    pendingTerminalEnvironment = null;
    if (environment === undefined) {
      terminalEnvironmentBySessionId.delete(sessionId);
    } else {
      terminalEnvironmentBySessionId.set(sessionId, environment);
    }
  };
  ctx.late.clientTerminals = ctx.options.clientTerminals === undefined
      ? undefined
      : yield* makeAcpClientTerminals({
          defaultCwd: ctx.input.runtimePolicy.cwd ?? process.cwd(),
          environment: ctx.options.clientTerminals.environment,
          shellCommands: ctx.options.clientTerminals.shellCommands,
          environmentForSession: (sessionId) => {
            const remembered = terminalEnvironmentBySessionId.get(sessionId);
            if (remembered !== undefined) return remembered;
            if (pendingTerminalEnvironment === null) return undefined;
            if (
              pendingTerminalEnvironment.sessionId === null &&
              pendingTerminalEnvironment.claimUnknownSession
            ) {
              pendingTerminalEnvironment = {
                ...pendingTerminalEnvironment,
                sessionId,
              };
            }
            return pendingTerminalEnvironment.sessionId === sessionId
              ? pendingTerminalEnvironment.environment
              : undefined;
          },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ctx.childProcessSpawner),
        );
  if (ctx.late.clientTerminals !== undefined) {
    yield* Scope.addFinalizer(ctx.sessionScope, ctx.late.clientTerminals.disposeAll);
  }
  const sessionScopedId = (sessionId: string, nativeId: string): string =>
    JSON.stringify([sessionId, nativeId]);
  const embeddedTerminalsByToolCallId = new Map<
    string,
    {
      readonly sessionId: string;
      readonly terminalIds: ReadonlyArray<string>;
      readonly toolCallId: string;
    }
  >();
  const toolCallIdsByAgentTerminalId = new Map<string, Set<string>>();
  const agentTerminalsById = new Map<string, AcpAgentTerminalState>();
  const rememberEmbeddedTerminals = (input: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly terminalIds: ReadonlyArray<string>;
  }): void => {
    const toolCallKey = sessionScopedId(input.sessionId, input.toolCallId);
    for (const terminalId of embeddedTerminalsByToolCallId.get(toolCallKey)?.terminalIds ??
      []) {
      const terminalKey = sessionScopedId(input.sessionId, terminalId);
      const toolCallIds = toolCallIdsByAgentTerminalId.get(terminalKey);
      toolCallIds?.delete(input.toolCallId);
      if (toolCallIds?.size === 0) toolCallIdsByAgentTerminalId.delete(terminalKey);
    }
    embeddedTerminalsByToolCallId.delete(toolCallKey);
    embeddedTerminalsByToolCallId.set(toolCallKey, {
      sessionId: input.sessionId,
      terminalIds: input.terminalIds,
      toolCallId: input.toolCallId,
    });
    for (const terminalId of input.terminalIds) {
      const terminalKey = sessionScopedId(input.sessionId, terminalId);
      const toolCallIds = toolCallIdsByAgentTerminalId.get(terminalKey) ?? new Set<string>();
      toolCallIds.add(input.toolCallId);
      toolCallIdsByAgentTerminalId.set(terminalKey, toolCallIds);
    }
    for (const oldest of embeddedTerminalsByToolCallId.keys()) {
      if (embeddedTerminalsByToolCallId.size <= 256) break;
      const remembered = embeddedTerminalsByToolCallId.get(oldest);
      if (remembered === undefined) continue;
      for (const terminalId of remembered.terminalIds) {
        const terminalKey = sessionScopedId(remembered.sessionId, terminalId);
        const toolCallIds = toolCallIdsByAgentTerminalId.get(terminalKey);
        toolCallIds?.delete(remembered.toolCallId);
        if (toolCallIds?.size === 0) toolCallIdsByAgentTerminalId.delete(terminalKey);
      }
      embeddedTerminalsByToolCallId.delete(oldest);
    }
  };
  const embeddedTerminalCommands = (
    sessionId: string,
    toolCallId: string,
  ): ReadonlyArray<string> =>
    (
      embeddedTerminalsByToolCallId.get(sessionScopedId(sessionId, toolCallId))
        ?.terminalIds ?? []
    ).flatMap((terminalId) => {
      const command =
        ctx.late.clientTerminals?.readCommandLine(terminalId) ??
        agentTerminalsById.get(sessionScopedId(sessionId, terminalId))?.command;
      return command === undefined ? [] : [command];
    });
  return {
    terminalEnvironmentBySessionId,
    prepareTerminalEnvironment,
    prepareClaimableTerminalEnvironment,
    rememberTerminalEnvironment,
    sessionScopedId,
    embeddedTerminalsByToolCallId,
    toolCallIdsByAgentTerminalId,
    agentTerminalsById,
    rememberEmbeddedTerminals,
    embeddedTerminalCommands,
    get pendingTerminalEnvironment() {
      return pendingTerminalEnvironment;
    },
    set pendingTerminalEnvironment(value) {
      pendingTerminalEnvironment = value;
    },
  };
});
