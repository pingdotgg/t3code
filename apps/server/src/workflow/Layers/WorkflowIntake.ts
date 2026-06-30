import type { ProjectId, ProviderInstanceId, WorkflowTicketProposal } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { providerInputBudget } from "../instructionTemplate.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { ProjectWorkspaceResolver } from "../Services/ProjectWorkspaceResolver.ts";
import { ProviderTurnPort } from "../Services/ProviderDispatchOutbox.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowIntakeService, type WorkflowIntakeShape } from "../Services/WorkflowIntake.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";

const INTAKE_TIMEOUT = "3 minutes";
const MAX_PROPOSALS = 20;
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 4000;

// Intake runs in approval-required mode, where any tool use (even a read)
// would stall on an approval nobody is there to grant — so the prompt forbids
// tools entirely and works from the braindump text alone.
const intakeInstruction = (braindump: string): string =>
  [
    "You are an intake assistant for a kanban board on this repository.",
    "Break the braindump below into independent, actionable tickets. Each",
    "ticket gets a short imperative title and a description with enough",
    "context for another engineer (or agent) to pick it up cold. Skip vague",
    "asides that are not actionable; merge duplicates.",
    "",
    "Work ONLY from the braindump text. Do not run commands, read files, or",
    "modify anything — answer directly.",
    "",
    "When the braindump implies ordering (build X, then Y on top of it), add",
    '"dependsOn" with the zero-based indices of EARLIER tickets in your list',
    "that must land first. Only reference earlier tickets.",
    "",
    "Braindump:",
    "---",
    braindump,
    "---",
    "",
    "End your final message with a single fenced ```json block of the form",
    '{"tickets": [{"title": "...", "description": "...", "dependsOn": [0]}]}.',
  ].join("\n");

/**
 * Validate the agent's parsed output into bounded proposals. Invalid entries
 * are dropped rather than failing the whole intake; overlong fields are
 * truncated. Returns an empty array when the shape is unusable.
 */
export const parseIntakeProposals = (output: unknown): ReadonlyArray<WorkflowTicketProposal> => {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return [];
  }
  const tickets = (output as Record<string, unknown>)["tickets"];
  if (!Array.isArray(tickets)) {
    return [];
  }
  const proposals: WorkflowTicketProposal[] = [];
  for (const raw of tickets) {
    if (proposals.length >= MAX_PROPOSALS) {
      break;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const title = typeof entry["title"] === "string" ? entry["title"].trim() : "";
    if (title === "") {
      continue;
    }
    const description = typeof entry["description"] === "string" ? entry["description"].trim() : "";
    // Backward-only index references: anything else (forward, self, junk) is
    // dropped rather than failing the proposal.
    const index = proposals.length;
    const rawDependsOn = entry["dependsOn"];
    const dependsOn = Array.isArray(rawDependsOn)
      ? [
          ...new Set(
            rawDependsOn.filter(
              (value): value is number =>
                typeof value === "number" && Number.isInteger(value) && value >= 0 && value < index,
            ),
          ),
        ]
      : [];
    proposals.push({
      title: title.slice(0, TITLE_MAX_LENGTH) as never,
      ...(description === "" ? {} : { description: description.slice(0, DESCRIPTION_MAX_LENGTH) }),
      ...(dependsOn.length === 0 ? {} : { dependsOn }),
    });
  }
  return proposals;
};

const intakeError = (message: string) => new WorkflowEventStoreError({ message });

const make = Effect.gen(function* () {
  const read = yield* WorkflowReadModel;
  const workspaces = yield* ProjectWorkspaceResolver;
  const turnPort = yield* ProviderTurnPort;
  const turnState = yield* TurnStateReader;
  const capturedOutputs = yield* CapturedStepOutputReader;
  const ids = yield* WorkflowIds;
  const providerService = yield* Effect.serviceOption(ProviderService);
  const orchestration = yield* Effect.serviceOption(OrchestrationEngineService);

  const cleanupSession = (threadId: string, turnId: unknown) =>
    Option.match(providerService, {
      onNone: () => Effect.void,
      onSome: (provider) =>
        provider.interruptTurn({ threadId: threadId as never, turnId: turnId as never }).pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(
            provider
              .stopSession({ threadId: threadId as never })
              .pipe(Effect.catch(() => Effect.void)),
          ),
        ),
    }).pipe(
      // Intake threads are one-shot scratch space — delete them once the
      // proposals (or the failure) have been extracted so they never
      // accumulate as orphaned hidden threads.
      Effect.andThen(
        Option.match(orchestration, {
          onNone: () => Effect.void,
          onSome: (engine) =>
            engine
              .dispatch({
                type: "thread.delete",
                commandId: `workflow-intake-delete-${threadId}` as never,
                threadId: threadId as never,
              })
              .pipe(
                Effect.catch(() => Effect.void),
                Effect.asVoid,
              ),
        }),
      ),
    );

  const proposeTickets: WorkflowIntakeShape["proposeTickets"] = (input) =>
    Effect.gen(function* () {
      const board = yield* read.getBoard(input.boardId);
      if (board === null) {
        return yield* intakeError(`Workflow board ${input.boardId} was not found`);
      }
      const cwd = yield* workspaces
        .resolve(board.projectId as ProjectId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowEventStoreError({ message: "intake workspace lookup failed", cause }),
          ),
        );

      // Reject an over-budget braindump before the turn starts: the assembled
      // prompt (wrapper + braindump) is what we'll send, so budget that string
      // against the selected model's input limit. Resolution failures (unknown
      // instance, no ProviderService) fall back to the 120k cap, which a
      // contract-capped (20k) braindump always clears.
      const maxInputChars = Option.isSome(providerService)
        ? yield* providerService.value
            .getCapabilities(input.agent.instance as ProviderInstanceId)
            .pipe(
              Effect.map((c) => c.maxInputChars),
              Effect.orElseSucceed(() => undefined),
            )
        : undefined;
      const budget = providerInputBudget(maxInputChars);
      const prompt = intakeInstruction(input.braindump);
      if (prompt.length > budget) {
        return yield* intakeError(
          `This braindump is too long for ${input.agent.model} ` +
            `(${prompt.length} of ${budget} characters). ` +
            `Shorten it, or choose a larger-context model for intake.`,
        );
      }

      const threadId = (yield* ids.eventId()) as string;
      // Synthetic ids: intake never writes to the dispatch outbox or any
      // ticket projection — the live turn port only uses thread/cwd/model.
      const syntheticId = `intake-${threadId}`;
      const { turnId } = yield* turnPort.ensureTurnStarted({
        dispatchId: syntheticId as never,
        ticketId: syntheticId as never,
        stepRunId: syntheticId as never,
        threadId: threadId as never,
        providerInstance: input.agent.instance as string,
        model: input.agent.model as string,
        instruction: prompt,
        worktreePath: cwd,
        ...(input.agent.options === undefined ? {} : { options: input.agent.options }),
        projectId: board.projectId,
        threadTitle: "Ticket intake",
        // Intake runs at the real project root, not a disposable worktree —
        // never give an unreviewed braindump write access. A write attempt
        // surfaces as awaiting_user, which intake treats as failure.
        runtimeMode: "approval-required",
      });

      const readProposals = Effect.gen(function* () {
        const awaitTerminal = Effect.gen(function* () {
          let state = yield* turnState.read(threadId as never);
          while (state._tag === "running") {
            yield* Effect.sleep("500 millis");
            state = yield* turnState.read(threadId as never);
          }
          return state;
        });
        const state = yield* awaitTerminal.pipe(
          Effect.timeoutOption(INTAKE_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () => intakeError("the intake agent did not finish in time"),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (state._tag === "awaiting_user") {
          return yield* intakeError(
            "the intake agent asked a question or requested write access — refine the braindump and retry",
          );
        }
        if (state._tag === "failed") {
          return yield* intakeError(`intake agent turn failed: ${state.error}`);
        }

        const output = yield* capturedOutputs.read({
          stepRunId: syntheticId as never,
          threadId: threadId as never,
          turnId,
        });
        const proposals = parseIntakeProposals(output);
        if (proposals.length === 0) {
          return yield* intakeError("the intake agent did not produce any usable ticket proposals");
        }
        return proposals;
      });
      // One-shot turn: whatever happens, never leave the provider session
      // (or a dangling question) running once intake returns.
      return yield* readProposals.pipe(Effect.ensuring(cleanupSession(threadId, turnId)));
    });

  return { proposeTickets } satisfies WorkflowIntakeShape;
});

export const WorkflowIntakeLive = Layer.effect(WorkflowIntakeService, make);
