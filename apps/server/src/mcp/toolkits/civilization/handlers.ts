import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CivilizationContext from "../../../civilization/ContextService.ts";
import * as Knowledge from "../../../civilization/KnowledgeService.ts";
import * as Mail from "../../../civilization/MailService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { CivilizationToolkit } from "./tools.ts";

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const mcpFailure = (error: unknown): OrchestratorMcpFailure => {
  if (isOrchestratorMcpFailure(error)) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as {
      readonly _tag: string;
      readonly message?: string;
      readonly reason?: string;
    };
    const message = tagged.message ?? "The Civilization operation could not be completed.";
    switch (tagged._tag) {
      case "CivilizationNoteNotFoundError":
      case "CivilizationKnowledgeConflictError":
      case "CivilizationKnowledgeInvalidError":
      case "CivilizationMailInvalidError":
      case "CivilizationMailNotFoundError":
      case "CivilizationMailConflictError":
      case "CivilizationMailCapacityError":
      case "CivilizationMailQuotaError":
        return new OrchestratorMcpFailure({ code: "invalid_request", message });
      case "CivilizationAgentAccessError":
        return new OrchestratorMcpFailure({
          code:
            tagged.reason === "stale_run" ||
            tagged.reason === "stale_epoch" ||
            tagged.reason === "closed_citizen"
              ? "parent_not_active"
              : "capability_denied",
          message,
        });
      case "CivilizationUnavailableError":
        return new OrchestratorMcpFailure({ code: "orchestration_error", message });
    }
  }
  return new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The Civilization operation could not be completed.",
  });
};

const resolveReadProject = Effect.fn("CivilizationMcp.resolveReadProject")(function* (
  projectId: ProjectId | undefined,
) {
  const caller = yield* readCaller();
  return { caller, projectId: yield* resolveProjectId(caller, projectId) } as const;
});

const authoritativeCitizenCaller = Effect.fn("CivilizationMcp.authoritativeCitizenCaller")(
  function* () {
    const caller = yield* readCaller();
    if (caller.caller === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_credential_required",
        message: "This Civilization mutation requires an agent running inside a T3 thread.",
      });
    }
    const knowledge = yield* Knowledge.CivilizationKnowledgeService;
    return yield* knowledge
      .authoritativeCaller({
        threadId: caller.caller.id,
        projectId: caller.caller.projectId,
        runtimeMode: caller.caller.runtimeMode,
        interactionMode: caller.caller.interactionMode,
      })
      .pipe(Effect.mapError(mcpFailure));
  },
);

const authoritativeMailCaller = Effect.fn("CivilizationMcp.authoritativeMailCaller")(function* () {
  const caller = yield* readCaller();
  if (caller.caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Civilization mail requires an agent running inside a T3 thread.",
    });
  }
  if (caller.caller.activeRunId === null) {
    return yield* new OrchestratorMcpFailure({
      code: "parent_not_active",
      message: "Civilization mail requires a live calling thread run.",
    });
  }
  const mail = yield* Mail.CivilizationMailService;
  return yield* mail
    .authoritativeCaller({
      threadId: caller.caller.id,
      projectId: caller.caller.projectId,
      runId: caller.caller.activeRunId,
      providerInstanceId: caller.caller.providerInstanceId,
      runtimeMode: caller.caller.runtimeMode,
      interactionMode: caller.caller.interactionMode,
    })
    .pipe(Effect.mapError(mcpFailure));
});

const explicitContextInput = Effect.fn("CivilizationMcp.explicitContextInput")(function* () {
  const caller = yield* readCaller();
  if (caller.caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Civilization context is scoped to an agent running inside a T3 thread.",
    });
  }
  const records = yield* caller.threads
    .getProjectThreadRecords({ projectId: caller.caller.projectId, threadId: caller.caller.id }, [
      "runs",
      "providerTurns",
    ])
    .pipe(Effect.mapError(mcpFailure));
  const activeRun = records.runs
    .filter((run) => run.id === caller.caller!.activeRunId)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  const attemptId = activeRun?.activeAttemptId ?? null;
  const providerTurn = records.providerTurns
    .filter((turn) => attemptId !== null && turn.runAttemptId === attemptId)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (activeRun === undefined || attemptId === null || providerTurn === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "parent_not_active",
      message:
        "The calling thread has no active provider turn for an explicit Civilization context read.",
    });
  }
  return {
    projectId: caller.caller.projectId,
    threadId: caller.caller.id,
    runId: activeRun.id,
    attemptId,
    providerTurnOrdinal: providerTurn.ordinal,
    providerInstanceId: activeRun.providerInstanceId,
    runtimeMode: caller.caller.runtimeMode,
    interactionMode: caller.caller.interactionMode,
  } satisfies CivilizationContext.CivilizationContextExplicitReadInput;
});

const handlers = {
  civilization_context: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller, projectId } = yield* resolveReadProject(input.projectId);
      if (caller.caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message:
            "Civilization context is scoped to a T3 thread. Use census or note reads for client inspection.",
        });
      }
      if (projectId !== caller.caller.projectId) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Civilization context can only describe the calling thread's own project.",
        });
      }
      const context = yield* CivilizationContext.CivilizationContextService;
      return yield* context.forExplicitRead(yield* explicitContextInput());
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_census: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveReadProject(input.projectId);
      const knowledge = yield* Knowledge.CivilizationKnowledgeService;
      return yield* knowledge.listCensus({
        projectId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_note_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveReadProject(input.projectId);
      const knowledge = yield* Knowledge.CivilizationKnowledgeService;
      return yield* knowledge.listNotes({
        projectId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.includeResolved === undefined ? {} : { includeResolved: input.includeResolved }),
        ...(input.selection === undefined ? {} : { selection: input.selection }),
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_note_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller, projectId } = yield* resolveReadProject(input.projectId);
      const knowledge = yield* Knowledge.CivilizationKnowledgeService;
      return yield* knowledge.readNoteBody({
        projectId,
        noteId: input.noteId,
        reader: caller.limits,
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_inbox_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* authoritativeMailCaller();
      const mail = yield* Mail.CivilizationMailService;
      return yield* mail.listInbox({
        caller,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.includeAcknowledged === undefined
          ? {}
          : { includeAcknowledged: input.includeAcknowledged }),
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_note_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* authoritativeCitizenCaller();
      const knowledge = yield* Knowledge.CivilizationKnowledgeService;
      return yield* knowledge.createNote({
        caller,
        clientRequestId: input.clientRequestId,
        category: input.category,
        body: input.body,
        ...(input.sourceReferences === undefined
          ? {}
          : { sourceReferences: input.sourceReferences }),
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_note_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* authoritativeCitizenCaller();
      const knowledge = yield* Knowledge.CivilizationKnowledgeService;
      return yield* knowledge.updateNote({
        caller,
        noteId: input.noteId,
        expectedRevision: input.expectedRevision,
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.sourceReferences === undefined
          ? {}
          : { sourceReferences: input.sourceReferences }),
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_note_resolve: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* authoritativeCitizenCaller();
      const knowledge = yield* Knowledge.CivilizationKnowledgeService;
      return yield* knowledge.resolveNote({
        caller,
        noteId: input.noteId,
        expectedRevision: input.expectedRevision,
        resolved: input.resolved,
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_mail_send: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* authoritativeMailCaller();
      const mail = yield* Mail.CivilizationMailService;
      return yield* mail.send({
        caller,
        targetThreadId: input.targetThreadId,
        clientRequestId: input.clientRequestId,
        body: input.body,
        ...(input.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: input.replyToMessageId }),
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_mail_receive: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* authoritativeMailCaller();
      const mail = yield* Mail.CivilizationMailService;
      return yield* mail.receive({
        caller,
        messageId: input.messageId,
        clientRequestId: input.clientRequestId,
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),

  civilization_mail_acknowledge: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* authoritativeMailCaller();
      const mail = yield* Mail.CivilizationMailService;
      return yield* mail.acknowledge({
        caller,
        messageId: input.messageId,
        clientRequestId: input.clientRequestId,
      });
    }).pipe(Effect.mapError(mcpFailure)),
  ),
} satisfies McpToolAccess.Handlers<typeof CivilizationToolkit.tools>;

export const layer = McpToolAccess.toLayer(CivilizationToolkit, handlers);
