import { CommandId, MessageId, ThreadId, type ThreadId as ThreadIdType } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import type { T3workThreadToolContextStoreShape } from "./t3work-threadToolContextStore.ts";
import { type T3workStartChildLoadThreadProject } from "./t3work-toolBrokerStartChildActivity.ts";
import {
  buildStartChildModelSelection,
  mapKickoffModeToInteractionMode,
  readModelSelectionReasoningEffort,
  readStartChildArgs,
} from "./t3work-toolBrokerStartChildArgs.ts";
import {
  hasLinkedRepositoryStartChildServices,
  hasProjectSetupScriptRunner,
  resolveLinkedRepositoryWorktree,
  startProjectSetupScript,
  type T3workStartChildServices,
} from "./t3work-toolBrokerStartChildContext.ts";
import {
  appendStartChildHandoffActivities,
  resolveStartChildHandoffPlacement,
} from "./t3work-toolBrokerStartChildHandoff.ts";
import { t3workRandomUUID } from "./t3work-random.ts";
import { buildStartChildResult } from "./t3work-toolBrokerStartChildResult.ts";
import {
  createChildThreadToolContext,
  readThreadDisplayModeFromToolContext,
  readTicketIdFromThreadToolContext,
} from "./t3work-toolBrokerStartChildToolContext.ts";

export function makeStartChildThread(input: {
  readonly loadThreadProject: T3workStartChildLoadThreadProject;
  readonly orchestration: OrchestrationEngineShape;
  readonly contextStore: T3workThreadToolContextStoreShape;
  readonly services: Partial<T3workStartChildServices>;
}) {
  return (threadId: ThreadIdType, rawArgs: unknown) =>
    Effect.gen(function* () {
      const parsed = readStartChildArgs(rawArgs);
      if (!parsed.ok) {
        return yield* Effect.fail(parsed.message);
      }

      const args = parsed.value;
      const { project, thread } = yield* input.loadThreadProject(threadId);
      const parentToolContext = yield* input.contextStore.get(threadId);
      const baseModelSelection = thread.modelSelection ?? project.defaultModelSelection;
      if (!baseModelSelection)
        return yield* Effect.fail("Current t3work thread does not have a model selection.");

      const childThreadId = ThreadId.make(t3workRandomUUID());
      const currentTicketId = readTicketIdFromThreadToolContext(parentToolContext);
      const currentDisplayMode = readThreadDisplayModeFromToolContext(parentToolContext);
      const { parentThreadId, ticketId } = resolveStartChildHandoffPlacement({
        currentDisplayMode,
        currentTicketId,
        requestedTicketId: args.ticketId,
        threadId: thread.id,
      });
      const modelSelection = buildStartChildModelSelection(baseModelSelection, args);
      const interactionMode = mapKickoffModeToInteractionMode(args.kickoffMode);
      const createdAt = DateTime.formatIso(yield* DateTime.now),
        requestedKickoffMode = args.kickoffMode ?? (args.kickoffPrompt ? "interactive" : undefined);

      let repoFullName: string | null = null,
        repoRef: string | null = null,
        branch: string | null = null,
        worktreePath: string | null = null;
      let setupScriptStatus: "not-requested" | "no-script" | "started" | "failed" = "not-requested",
        setupScriptTerminalId: string | null = null;

      if (args.repoFullName) {
        if (!hasLinkedRepositoryStartChildServices(input.services)) {
          return yield* Effect.fail(
            "t3work.thread.start_child linked repository support is unavailable in this runtime.",
          );
        }

        const resolvedRepository = yield* resolveLinkedRepositoryWorktree({
          services: input.services,
          projectWorkspaceRoot: project.workspaceRoot,
          repoFullName: args.repoFullName,
          ...(args.repoRef ? { repoRef: args.repoRef } : {}),
          sessionName: args.name,
          childThreadId,
        });
        ({ repoFullName, repoRef, branch, worktreePath } = resolvedRepository);
      }

      const childToolContext = createChildThreadToolContext({
        parentToolContext,
        projectId: thread.projectId,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        threadId: childThreadId,
        threadTitle: args.name,
        ...(ticketId ? { ticketId } : {}),
      });

      yield* input.orchestration.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`server:t3work:start-child:create:${t3workRandomUUID()}`),
        threadId: childThreadId,
        projectId: thread.projectId,
        title: args.name,
        modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode,
        branch,
        worktreePath,
        createdAt,
      });

      if (childToolContext) {
        yield* input.contextStore.put({ threadId: childThreadId, toolContext: childToolContext });
      }

      if (worktreePath) {
        if (hasProjectSetupScriptRunner(input.services)) {
          const setupResult = yield* startProjectSetupScript({
            services: input.services,
            threadId: childThreadId,
            projectId: thread.projectId,
            worktreePath,
          });
          if (setupResult.status === "started") {
            setupScriptStatus = "started";
            setupScriptTerminalId = setupResult.terminalId;
          } else if (setupResult.status === "no-script") {
            setupScriptStatus = "no-script";
          } else {
            setupScriptStatus = "failed";
          }
        } else {
          setupScriptStatus = "failed";
        }
      }

      yield* appendStartChildHandoffActivities({
        orchestration: input.orchestration,
        threadId: thread.id,
        threadTitle: thread.title,
        childThreadId,
        childTitle: args.name,
        createdAt,
        ...(parentThreadId ? { handoffParentThreadId: parentThreadId } : {}),
        ...(ticketId ? { ticketId } : {}),
        ...(repoFullName ? { repoFullName } : {}),
        ...(repoRef ? { repoRef } : {}),
        ...(branch ? { branch } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(args.kickoffPrompt ? { kickoffPrompt: args.kickoffPrompt } : {}),
      });

      let started = false,
        startupError: string | undefined;

      if (args.kickoffPrompt) {
        const kickoffCreatedAt = DateTime.formatIso(yield* DateTime.now);
        const startResult = yield* input.orchestration
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`server:t3work:start-child:kickoff:${t3workRandomUUID()}`),
            threadId: childThreadId,
            message: {
              messageId: MessageId.make(t3workRandomUUID()),
              role: "user",
              text: args.kickoffPrompt,
              attachments: [],
            },
            modelSelection,
            titleSeed: args.name,
            runtimeMode: thread.runtimeMode,
            interactionMode,
            createdAt: kickoffCreatedAt,
          })
          .pipe(Effect.result);

        if (startResult._tag === "Success") {
          started = true;
        } else {
          startupError =
            startResult.failure instanceof Error
              ? startResult.failure.message
              : String(startResult.failure);
        }
      }

      const reasoningEffort = readModelSelectionReasoningEffort(modelSelection);
      return buildStartChildResult({
        projectId: thread.projectId,
        childThreadId,
        name: args.name,
        executionScope: args.executionScope,
        started,
        interactionMode,
        runtimeMode: thread.runtimeMode,
        model: modelSelection.model,
        ...(args.model ? { requestedModel: args.model } : {}),
        setupScriptStatus,
        ...(requestedKickoffMode ? { requestedKickoffMode } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        repoFullName,
        repoRef,
        branch,
        worktreePath,
        setupScriptTerminalId,
        ...(startupError ? { startupError } : {}),
      });
    });
}
