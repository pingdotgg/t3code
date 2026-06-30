import {
  ProviderInstanceId,
  TrimmedNonEmptyString,
  type ProjectId,
  type StepOutcome,
  type TurnId,
  type WorkflowStepUsage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { ProjectScriptTrust } from "../Services/ProjectScriptTrust.ts";
import {
  ProviderDispatchOutbox,
  type ProviderDispatchTerminalResult,
} from "../Services/ProviderDispatchOutbox.ts";
import { ScriptStepExecutor } from "../Services/ScriptStepExecutor.ts";
import { SetupRunService } from "../Services/SetupRunService.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { StepOutputHandoffReader } from "../Services/StepOutputHandoffReader.ts";
import { StepUsageReader } from "../Services/StepUsageReader.ts";
import { TicketCheckpointService } from "../Services/TicketCheckpointService.ts";
import { TicketMergeService } from "../Services/TicketMergeService.ts";
import { TicketPullRequestService } from "../Services/TicketPullRequestService.ts";
import { WorkflowAgentSessionStore } from "../Services/WorkflowAgentSessionStore.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorktreeLeaseService } from "../Services/WorktreeLeaseService.ts";
import {
  WorktreePort,
  type WorktreeHandle,
  type WorktreePortShape,
} from "../Services/WorktreePort.ts";
import {
  containsRealPath,
  resolveWorkflowInstructionPath,
  unsafeWorkflowInstructionPathMessage,
} from "../instructionPath.ts";
import {
  applyInstructionTemplateExcept,
  descriptionSpillPath,
  descriptionSpillReference,
  DISCUSSION_MESSAGE_CAP,
  findHandoffReferences,
  handoffSpillPath,
  handoffSpillReference,
  hasDiscussionPlaceholder,
  instructionBodyBudget,
  NO_PRIOR_OUTPUT_NOTE,
  providerInputBudget,
  renderTicketDiscussion,
  stringifyHandoffOutput,
} from "../instructionTemplate.ts";
import { ticketBaseRef } from "../ticketRefs.ts";
import { agentKey as deriveAgentKey } from "../agentSessionKey.ts";

const toExecutorError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toExecutorError(message)));

const executorErrorDetail = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { readonly message?: unknown; readonly cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : String(error);
    const cause =
      typeof candidate.cause === "object" && candidate.cause !== null
        ? (candidate.cause as { readonly message?: unknown })
        : null;
    return typeof cause?.message === "string" && cause.message.length > 0
      ? `${message}: ${cause.message}`
      : message;
  }
  return String(error);
};

const CAPTURE_OUTPUT_INSTRUCTION =
  "End your final message with a single fenced ```json block containing your result object. " +
  "This requirement overrides any skill, workflow, or output format your other instructions ask for — " +
  "whatever else you produce, the fenced json block must be the last thing you write.";

const appendCaptureOutputInstruction = (instruction: string) =>
  `${instruction.trimEnd()}\n\n${CAPTURE_OUTPUT_INSTRUCTION}`;

interface TicketProjectRow {
  readonly repoRoot: string;
  readonly projectId: string;
}

const make = Effect.gen(function* () {
  const worktrees = yield* WorktreePort;
  const lease = yield* WorktreeLeaseService;
  const setup = yield* SetupRunService;
  const dispatch = yield* ProviderDispatchOutbox;
  const ids = yield* WorkflowIds;
  const read = yield* WorkflowReadModel;
  const scriptExecutor = yield* ScriptStepExecutor;
  const scriptTrust = yield* ProjectScriptTrust;
  const capturedOutputs = yield* CapturedStepOutputReader;
  const merges = yield* TicketMergeService;
  const pullRequests = yield* TicketPullRequestService;
  const ticketCheckpoints = yield* TicketCheckpointService;
  const committer = yield* WorkflowEventCommitter;
  const agentSessions = yield* WorkflowAgentSessionStore;
  const handoffReader = yield* StepOutputHandoffReader;
  const fileSystem = yield* FileSystem.FileSystem;
  // Optional: token-usage capture is best-effort telemetry, absent in older
  // test stacks.
  const usageReader = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<StepUsageReader>,
    StepUsageReader,
  );
  const readStepUsage = (threadId: string) =>
    Option.isNone(usageReader)
      ? // @effect-diagnostics-next-line effectSucceedWithVoid:off — must stay `Effect<undefined>` (not `Effect<void>`) so it unifies with read()'s `WorkflowStepUsage | undefined` and feeds sumUsage
        Effect.succeed<WorkflowStepUsage | undefined>(undefined)
      : usageReader.value.read(threadId as never);

  const prepareWorktreeStep = (
    ctx: Parameters<StepExecutorShape["execute"]>[0],
    body: (worktree: WorktreeHandle) => Effect.Effect<StepOutcome, WorkflowEventStoreError>,
    options?: {
      readonly preSetupGuard?: (
        worktree: WorktreeHandle,
      ) => Effect.Effect<StepOutcome | null, WorkflowEventStoreError>;
      readonly skipSetup?: boolean;
      // When true, the project's setup script is only run if the worktree's
      // project is trusted; an untrusted project's setup is SKIPPED (its
      // arbitrary shell never executes) without failing the step.
      readonly gateSetupOnTrust?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      const worktree = yield* worktrees.ensureWorktree(ctx.ticketId);
      const hasBaseline = yield* ticketCheckpoints.hasBaseline(ctx.ticketId, worktree.path);
      if (!hasBaseline) {
        yield* ticketCheckpoints.captureBaseline(ctx.ticketId, worktree.path);
      }

      const guarded = yield* options?.preSetupGuard?.(worktree) ?? Effect.succeed(null);
      if (guarded !== null) {
        return guarded;
      }

      let runSetupStep = options?.skipSetup !== true;
      if (runSetupStep && options?.gateSetupOnTrust === true && worktree.projectId !== undefined) {
        const trusted = yield* scriptTrust.isTrusted(worktree.projectId as ProjectId);
        if (!trusted) {
          // Untrusted project: withhold the setup script (arbitrary code) but let
          // the agent step proceed. Distinct from the script-step guard, which
          // blocks because the script IS the untrusted surface.
          runSetupStep = false;
          yield* Effect.logWarning("skipping setup for untrusted project on agent step", {
            ticketId: ctx.ticketId,
            projectId: worktree.projectId,
          });
        }
      }
      if (runSetupStep) {
        const setupRunId = yield* ids.eventId();
        const setupResult = yield* setup.runSetup(
          ctx.ticketId,
          worktree.worktreeRef,
          worktree.path,
          setupRunId as never,
          worktree.projectId,
        );
        if (setupResult.status !== "completed") {
          return { _tag: "failed", error: `setup ${setupResult.status}` } satisfies StepOutcome;
        }
      }

      const acquired = yield* lease.acquire(worktree.worktreeRef, "step", ctx.stepRunId as string);
      const releaseIfStillOwner = lease.isValid(worktree.worktreeRef, acquired.fenceToken).pipe(
        Effect.flatMap((valid) =>
          valid ? lease.release(worktree.worktreeRef, acquired.fenceToken) : Effect.void,
        ),
        Effect.orElseSucceed(() => undefined),
      );

      const result = yield* Effect.gen(function* () {
        const preRef = yield* ticketCheckpoints.captureStep(
          ctx.ticketId,
          ctx.stepRunId,
          worktree.path,
          "pre",
        );
        const bodyExit = yield* body(worktree).pipe(Effect.exit);
        const postRef = yield* ticketCheckpoints.captureStep(
          ctx.ticketId,
          ctx.stepRunId,
          worktree.path,
          "post",
        );
        const eventId = yield* ids.eventId();
        const occurredAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* committer.commit({
          type: "StepRefsCaptured",
          eventId: eventId as never,
          ticketId: ctx.ticketId,
          occurredAt: occurredAt as never,
          payload: { stepRunId: ctx.stepRunId, preRef, postRef },
        });
        if (Exit.isFailure(bodyExit)) {
          return yield* Effect.failCause(bodyExit.cause);
        }
        return bodyExit.value;
      }).pipe(Effect.ensuring(releaseIfStillOwner));

      return result;
    });

  const providerServiceOption = Effect.serviceOption(ProviderService);

  const cleanupStepSession = (threadId: string, turnId: TurnId) =>
    Effect.gen(function* () {
      const provider = yield* providerServiceOption;
      if (Option.isNone(provider)) {
        return;
      }
      yield* provider.value
        .interruptTurn({ threadId: threadId as never, turnId: turnId as never })
        .pipe(Effect.catch(() => Effect.void));
      yield* provider.value
        .stopSession({ threadId: threadId as never })
        .pipe(Effect.catch(() => Effect.void));
    });

  const sumUsage = (
    total: WorkflowStepUsage | undefined,
    next: WorkflowStepUsage | undefined,
  ): WorkflowStepUsage | undefined => {
    if (next === undefined) {
      return total;
    }
    if (total === undefined) {
      return next;
    }
    const add = (a: number | undefined, b: number | undefined) =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    return {
      ...(add(total.inputTokens, next.inputTokens) === undefined
        ? {}
        : { inputTokens: add(total.inputTokens, next.inputTokens) }),
      ...(add(total.cachedInputTokens, next.cachedInputTokens) === undefined
        ? {}
        : { cachedInputTokens: add(total.cachedInputTokens, next.cachedInputTokens) }),
      ...(add(total.outputTokens, next.outputTokens) === undefined
        ? {}
        : { outputTokens: add(total.outputTokens, next.outputTokens) }),
      ...(add(total.totalTokens, next.totalTokens) === undefined
        ? {}
        : { totalTokens: add(total.totalTokens, next.totalTokens) }),
    };
  };

  const verdictOf = (output: unknown): string | null => {
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
      return null;
    }
    const verdict = (output as Record<string, unknown>)["verdict"];
    return typeof verdict === "string" ? verdict : null;
  };

  // Fan out `panelSize` independent turns of the same review step and take
  // the strict-majority verdict. A member that fails, stalls on a question,
  // or returns unusable output simply contributes no vote; without a strict
  // majority the step fails (never silently picks a side).
  const runReviewPanel = (
    ctx: Parameters<StepExecutorShape["execute"]>[0],
    step: Extract<Parameters<StepExecutorShape["execute"]>[0]["step"], { readonly type: "agent" }>,
    panelSize: number,
    runTurn: (
      turnIds: { readonly dispatchId: string; readonly threadId: string },
      titleSuffix: string,
    ) => Effect.Effect<
      {
        readonly terminal: ProviderDispatchTerminalResult;
        readonly turnId: TurnId;
        readonly threadId: string;
      },
      WorkflowEventStoreError
    >,
  ) =>
    Effect.gen(function* () {
      const memberIds = yield* Effect.forEach(
        Array.from({ length: panelSize }, (_, index) => index),
        () =>
          Effect.all({
            dispatchId: ids.eventId().pipe(Effect.map((id) => id as string)),
            threadId: ids.eventId().pipe(Effect.map((id) => id as string)),
          }),
      );
      // Members run sequentially: they share the ticket worktree, and two
      // concurrent full-access agents in one tree can corrupt each other's
      // view. Review steps are read-mostly, so serial members are safe even
      // if one misbehaves and writes.
      const members = yield* Effect.all(
        memberIds.map((turnIds, index) =>
          runTurn(turnIds, ` (reviewer ${index + 1}/${panelSize})`),
        ),
        { concurrency: 1 },
      );

      let usage: WorkflowStepUsage | undefined;
      const votes: Array<{
        readonly reviewer: number;
        readonly verdict: string | null;
        readonly output: unknown;
        readonly error?: string;
      }> = [];
      for (const [index, member] of members.entries()) {
        usage = sumUsage(usage, yield* readStepUsage(member.threadId));
        if (!member.terminal.ok) {
          votes.push({
            reviewer: index + 1,
            verdict: null,
            output: null,
            error:
              "awaitingUser" in member.terminal
                ? "reviewer asked a question"
                : (member.terminal.error ?? "turn failed"),
          });
          continue;
        }
        const output = yield* capturedOutputs.read({
          stepRunId: ctx.stepRunId,
          threadId: member.threadId as never,
          turnId: member.turnId,
        });
        votes.push({
          reviewer: index + 1,
          verdict: verdictOf(output),
          output: output ?? null,
        });
      }

      // A member that stalled on a question (or failed mid-turn) leaves a
      // live provider session and an unconfirmed outbox row nobody is meant
      // to answer — stop the session and settle every member row so restart
      // recovery never re-monitors a decided panel.
      for (const member of members) {
        if (member.terminal.ok) {
          continue;
        }
        // cleanupStepSession already swallows its own failures (its error channel
        // is `never`), so this is a defensive best-effort guard; `Effect.ignore`
        // discards any typed failure while letting genuine defects surface.
        yield* cleanupStepSession(member.threadId, member.turnId).pipe(Effect.ignore);
      }
      yield* dispatch.confirmStep(ctx.stepRunId).pipe(Effect.catch(() => Effect.void));

      const counts = new Map<string, number>();
      for (const vote of votes) {
        if (vote.verdict !== null) {
          counts.set(vote.verdict, (counts.get(vote.verdict) ?? 0) + 1);
        }
      }
      let winner: string | null = null;
      let winnerCount = 0;
      for (const [verdict, count] of counts) {
        if (count > winnerCount) {
          winner = verdict;
          winnerCount = count;
        }
      }
      if (winner !== null && winnerCount * 2 > panelSize) {
        return {
          _tag: "completed",
          output: { verdict: winner, votes },
          ...(usage === undefined ? {} : { usage }),
        } satisfies StepOutcome;
      }
      return {
        _tag: "failed",
        error: `review panel did not reach a majority (${votes
          .map((vote) => vote.verdict ?? "no vote")
          .join(", ")})`,
        ...(usage === undefined ? {} : { usage }),
      } satisfies StepOutcome;
    });

  // Resolve a single handoff variable to its source step's captured output.
  // `prev` reads the immediately-preceding step in THIS pass; `step.<key>`
  // reads this pass first, then the latest completed prior pass (loop). A
  // forward reference with nothing captured yet resolves to null.
  const resolveHandoffSource = (
    ctx: Parameters<StepExecutorShape["execute"]>[0],
    sourceStepKey: string | null,
  ) =>
    Effect.gen(function* () {
      if (sourceStepKey === null) {
        return null;
      }
      const thisPass = yield* handoffReader.currentPassOutput(
        ctx.pipelineRunId,
        sourceStepKey as never,
      );
      if (thisPass !== null) {
        return thisPass;
      }
      return yield* handoffReader.latestCompletedOutput(
        ctx.ticketId,
        ctx.laneKey,
        sourceStepKey as never,
      );
    });

  // Resolve `{{prev.output}}` / `{{step.<key>.output}}` in the assembled
  // instruction. Each resolved output is inlined when the running assembled
  // instruction stays under the handoff budget (the provider input cap minus
  // reserved room for discussion + capture suffix); otherwise the full output
  // spills to `.t3/ticket/<id>/handoff/<safeKey>.md` in the worktree and a path
  // reference is substituted. Spill files live in the per-ticket scratch tree
  // the merge step purges, so they never reach the branch/PR.
  const resolveHandoffPlaceholders = (
    ctx: Parameters<StepExecutorShape["execute"]>[0],
    worktree: WorktreeHandle,
    step: Extract<Parameters<StepExecutorShape["execute"]>[0]["step"], { readonly type: "agent" }>,
    baseInstruction: string,
    bodyBudget: number,
  ) =>
    Effect.gen(function* () {
      const references = findHandoffReferences(baseInstruction);
      if (references.length === 0) {
        return baseInstruction;
      }
      const stepKeys = ctx.laneStepKeys as ReadonlyArray<string>;
      const currentIndex = stepKeys.indexOf(step.key as string);
      const precedingStepKey = currentIndex > 0 ? (stepKeys[currentIndex - 1] ?? null) : null;

      let assembled = baseInstruction;
      // Tracks the projected final length as inlines accumulate, so the budget
      // applies to the WHOLE assembled instruction, not each output in isolation.
      let assembledLength = baseInstruction.length;
      for (const reference of references) {
        const sourceStepKey =
          reference.kind === "prev" ? precedingStepKey : (reference.stepKey ?? null);
        const output = yield* resolveHandoffSource(ctx, sourceStepKey);
        let replacement: string;
        if (output === null) {
          replacement = NO_PRIOR_OUTPUT_NOTE;
        } else {
          const rendered = stringifyHandoffOutput(output);
          const projected = assembledLength - reference.raw.length + rendered.length;
          if (projected > bodyBudget && sourceStepKey !== null) {
            const relativePath = handoffSpillPath(ctx.ticketId as string, sourceStepKey);
            const absolutePath = `${worktree.path}/${relativePath}`;
            const directory = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
            yield* fileSystem
              .makeDirectory(directory, { recursive: true })
              .pipe(Effect.mapError(toExecutorError("handoff spill directory create failed")));
            yield* fileSystem
              .writeFileString(absolutePath, rendered)
              .pipe(Effect.mapError(toExecutorError("handoff spill write failed")));
            replacement = handoffSpillReference(relativePath);
          } else {
            replacement = rendered;
          }
        }
        // Function replacer: a string replacement would interpret `$`
        // sequences (e.g. `$&`) in agent output as special patterns.
        assembled = assembled.replace(reference.raw, () => replacement);
        assembledLength = assembledLength - reference.raw.length + replacement.length;
      }
      return assembled;
    });

  const executeAgentStep = (
    ctx: Parameters<StepExecutorShape["execute"]>[0],
    worktree: WorktreeHandle,
    step: Extract<Parameters<StepExecutorShape["execute"]>[0]["step"], { readonly type: "agent" }>,
  ) =>
    Effect.gen(function* () {
      // Budget gate: once the ticket's usage roll-up reaches its budget, no
      // further provider turns start — the step blocks (not fails) so a human
      // can raise the budget or move the ticket on.
      const budgetDetail = yield* read.getTicketDetail(ctx.ticketId);
      const tokenBudget = budgetDetail?.ticket.tokenBudget;
      const usedTokens = budgetDetail?.ticket.totalTokens ?? 0;
      if (typeof tokenBudget === "number" && usedTokens >= tokenBudget) {
        return {
          _tag: "blocked",
          reason: `token budget reached (${usedTokens.toLocaleString("en-US")} of ${tokenBudget.toLocaleString("en-US")} tokens used)`,
        } satisfies StepOutcome;
      }
      const dispatchId = yield* ids.eventId();
      const mintedThreadId = yield* ids.eventId();
      // A `continueSession` agent step resumes its own provider session across
      // steps/loops by reusing a stable workflow `threadId` anchored to
      // (ticket, lane, agentKey): `startSession(threadId)` replays the persisted
      // resume cursor. On a miss we mint a fresh thread and record it; on a hit
      // we dispatch the stored thread (and never overwrite it). Panel members
      // always keep fresh ids — lint forbids continueSession + panel.
      const threadId =
        step.continueSession === true
          ? yield* Effect.gen(function* () {
              const agentKey = deriveAgentKey(
                step.agent.instance as string,
                step.agent.model as string,
                step.agent.options,
              );
              const existing = yield* agentSessions.getThreadId(
                ctx.ticketId,
                ctx.laneKey,
                agentKey,
              );
              if (existing !== null) {
                return existing;
              }
              yield* agentSessions.upsert(
                ctx.ticketId,
                ctx.laneKey,
                agentKey,
                mintedThreadId as string,
              );
              return mintedThreadId as string;
            })
          : (mintedThreadId as string);
      const resolvedInstruction = yield* Effect.gen(function* () {
        if (typeof step.instruction === "string") {
          return step.instruction;
        }

        const instructionFile = step.instruction.file;
        const instructionPath = resolveWorkflowInstructionPath(worktree.repoRoot, instructionFile);
        if (instructionPath === null) {
          return yield* new WorkflowEventStoreError({
            message: unsafeWorkflowInstructionPathMessage(instructionFile),
          });
        }

        const realRepoRoot = yield* fileSystem
          .realPath(worktree.repoRoot)
          .pipe(Effect.mapError(toExecutorError("instruction file realpath check failed")));
        const realInstructionPath = yield* fileSystem
          .realPath(instructionPath)
          .pipe(Effect.mapError(toExecutorError("instruction file realpath check failed")));
        if (!containsRealPath(realRepoRoot, realInstructionPath)) {
          return yield* Effect.succeed({
            _tag: "failed",
            error: `Instruction file resolves outside the project root: "${instructionFile}"`,
          } satisfies StepOutcome);
        }

        return yield* fileSystem
          .readFileString(realInstructionPath)
          .pipe(Effect.mapError(toExecutorError("instruction file read failed")));
      });
      if (typeof resolvedInstruction !== "string") {
        return resolvedInstruction;
      }
      // Attachment-count-only query capped one past the renderer's message
      // budget, so long threads never decode attachment data URLs here.
      const discussion = renderTicketDiscussion(
        yield* read.listTicketDiscussion(ctx.ticketId, DISCUSSION_MESSAGE_CAP + 1),
      );
      // Resolve the active provider's per-turn input budget (clamped to 120k).
      // Absent ProviderService (some test layers) or a failed lookup → 120k.
      const providerSvcOpt = yield* providerServiceOption;
      const maxInputChars = Option.isSome(providerSvcOpt)
        ? yield* providerSvcOpt.value
            .getCapabilities(step.agent.instance as ProviderInstanceId)
            .pipe(
              Effect.map((c) => c.maxInputChars),
              Effect.orElseSucceed(() => undefined),
            )
        : undefined;
      const providerBudget = providerInputBudget(maxInputChars);

      // The discussion block appended after the body (0 when inlined via the
      // {{ticket.discussion}} placeholder). Reserved exactly against the budget.
      const appendedDiscussionBlock =
        discussion !== "" && !hasDiscussionPlaceholder(resolvedInstruction)
          ? `\n\n## Ticket discussion\n\n${discussion}`
          : "";
      const bodyBudget = instructionBodyBudget(
        providerBudget,
        appendedDiscussionBlock.length,
        step.captureOutput === true,
      );

      // Substitute the short ticket fields, decide whether the {{ticket.description}}
      // body inlines or spills, resolve handoff against the SKELETON (description
      // still a marker), then substitute the description. Resolving handoff before
      // the description is spliced in is deliberate: it stops the handoff scanner
      // from matching {{prev.output}}/{{step.k.output}} text that happens to appear
      // inside a ticket description (which would silently mangle the description).
      const instructionWithHandoff = resolvedInstruction.includes("{{")
        ? yield* Effect.gen(function* () {
            const detail = yield* read.getTicketDetail(ctx.ticketId);
            const title = detail?.ticket.title ?? "";
            const rawDescription = detail?.ticket.description ?? "";
            const templatedShort = applyInstructionTemplateExcept(
              resolvedInstruction,
              {
                title,
                id: ctx.ticketId as string,
                baseRef: ticketBaseRef(ctx.ticketId),
                ...(hasDiscussionPlaceholder(resolvedInstruction)
                  ? { discussion: discussion === "" ? "(no discussion yet)" : discussion }
                  : {}),
              },
              ["description"],
            );
            const descRefs = [...templatedShort.matchAll(/\{\{\s*ticket\.description\s*\}\}/g)];
            // Sum the ACTUAL matched marker lengths (the pattern allows internal
            // whitespace), so the inline projection is exact.
            const matchedLen = descRefs.reduce((n, m) => n + m[0].length, 0);
            const pointer = descriptionSpillReference(descriptionSpillPath(ctx.ticketId as string));
            // Spilling only helps when there is a body and the pointer is shorter
            // than it (otherwise inlining produces the smaller prompt).
            const canSpillDescription =
              descRefs.length > 0 &&
              rawDescription.length > 0 &&
              pointer.length < rawDescription.length;
            const spillDescriptionFile = Effect.gen(function* () {
              const spillPath = descriptionSpillPath(ctx.ticketId as string);
              const absolute = `${worktree.path}/${spillPath}`;
              const dir = absolute.slice(0, absolute.lastIndexOf("/"));
              yield* fileSystem
                .makeDirectory(dir, { recursive: true })
                .pipe(Effect.mapError(toExecutorError("description spill dir create failed")));
              yield* fileSystem
                .writeFileString(absolute, `# ${title.split("\n")[0]}\n\n${rawDescription}`)
                .pipe(Effect.mapError(toExecutorError("description spill write failed")));
            });
            // Decide the description replacement: inline if it fits, otherwise spill
            // it to a worktree scratch file and point the agent at it.
            let descriptionReplacement = rawDescription;
            if (canSpillDescription) {
              const inlineProjection =
                templatedShort.length - matchedLen + descRefs.length * rawDescription.length;
              if (inlineProjection > bodyBudget) {
                yield* spillDescriptionFile;
                descriptionReplacement = pointer;
              }
            }
            // Net length the description substitution adds to the body; reserve it
            // out of the handoff budget so the final assembled body stays bounded.
            const descriptionDelta = descRefs.length * descriptionReplacement.length - matchedLen;
            const resolvedSkeleton = yield* resolveHandoffPlaceholders(
              ctx,
              worktree,
              step,
              templatedShort,
              Math.max(0, bodyBudget - descriptionDelta),
            );
            // Final-fit fallback: handoff spilling adds small pointer-reference
            // overhead the up-front description projection couldn't account for. If
            // the assembled body (skeleton + inlined description) would still exceed
            // the body budget, spill the description now — it's the largest
            // reclaimable blob. providerBudget − bodyBudget already reserves the
            // appended discussion + capture suffix, so body ≤ bodyBudget keeps the
            // final prompt within the provider budget.
            if (canSpillDescription && descriptionReplacement === rawDescription) {
              const inlinedBodyLength = resolvedSkeleton.length + descriptionDelta;
              if (inlinedBodyLength > bodyBudget) {
                yield* spillDescriptionFile;
                descriptionReplacement = pointer;
              }
            }
            // Splice the description in LAST — its literal {{...}} text is never
            // scanned for handoff placeholders.
            return resolvedSkeleton.replace(
              /\{\{\s*ticket\.description\s*\}\}/g,
              () => descriptionReplacement,
            );
          })
        : resolvedInstruction;
      // Comments always reach the next agent step: unless the instruction
      // already placed the transcript via {{ticket.discussion}}, append it.
      const instructionWithDiscussion =
        appendedDiscussionBlock !== ""
          ? `${instructionWithHandoff}${appendedDiscussionBlock}`
          : instructionWithHandoff;
      const instruction =
        step.captureOutput === true
          ? appendCaptureOutputInstruction(instructionWithDiscussion)
          : instructionWithDiscussion;
      if (instruction.length > providerBudget) {
        yield* Effect.logWarning(
          `workflow step ${step.key} prompt (${instruction.length}) exceeds provider budget (${providerBudget}) after spilling`,
        );
      }
      const runTurn = (
        turnIds: { readonly dispatchId: string; readonly threadId: string },
        titleSuffix: string,
      ) =>
        Effect.gen(function* () {
          const started = yield* dispatch.ensureStarted({
            dispatchId: turnIds.dispatchId as never,
            ticketId: ctx.ticketId,
            stepRunId: ctx.stepRunId,
            threadId: turnIds.threadId as never,
            providerInstance: step.agent.instance as string,
            model: step.agent.model as string,
            instruction,
            worktreePath: worktree.path,
            ...(step.agent.options === undefined ? {} : { options: step.agent.options }),
            ...(worktree.projectId === undefined ? {} : { projectId: worktree.projectId }),
            threadTitle: `Workflow step ${step.key}${titleSuffix} · ${ctx.ticketId}`,
          });
          const terminal = yield* dispatch.awaitTerminal(
            turnIds.dispatchId as never,
            turnIds.threadId as never,
          );
          return { terminal, turnId: started.turnId, threadId: turnIds.threadId };
        });

      const panelSize = step.panel ?? 0;
      if (panelSize >= 2 && step.captureOutput === true) {
        return yield* runReviewPanel(ctx, step, panelSize, runTurn);
      }

      const result = yield* runTurn(
        { dispatchId: dispatchId as string, threadId: threadId as string },
        "",
      );

      if (result.terminal.ok) {
        const usage = yield* readStepUsage(threadId as string);
        if (step.captureOutput === true) {
          const output = yield* capturedOutputs.read({
            stepRunId: ctx.stepRunId,
            threadId: threadId as never,
            turnId: result.turnId,
          });
          if (output === undefined) {
            return {
              _tag: "failed",
              error: "missing or invalid structured output",
              ...(usage === undefined ? {} : { usage }),
            } satisfies StepOutcome;
          }
          return {
            _tag: "completed",
            output,
            ...(usage === undefined ? {} : { usage }),
          } satisfies StepOutcome;
        }
        return {
          _tag: "completed",
          ...(usage === undefined ? {} : { usage }),
        } satisfies StepOutcome;
      }
      if ("awaitingUser" in result.terminal) {
        return {
          _tag: "awaiting_user",
          waitingReason: result.terminal.waitingReason,
          providerThreadId: result.terminal.providerThreadId,
          providerRequestId: result.terminal.providerRequestId,
          providerResponseKind: result.terminal.providerResponseKind,
          ...(result.terminal.providerQuestionId === undefined
            ? {}
            : { providerQuestionId: result.terminal.providerQuestionId }),
        } satisfies StepOutcome;
      }
      // The turn may still be live (e.g. the terminal-wait timed out): stop
      // the provider session so the agent cannot keep mutating the worktree
      // while the pipeline routes on. Interrupting an already-terminal turn
      // is a harmless no-op.
      yield* cleanupStepSession(result.threadId, result.turnId);
      const failureUsage = yield* readStepUsage(threadId as string);
      return {
        _tag: "failed",
        error: result.terminal.error ?? "turn failed",
        ...(failureUsage === undefined ? {} : { usage: failureUsage }),
      } satisfies StepOutcome;
    });

  const scriptTrustGuard = (ctx: Parameters<StepExecutorShape["execute"]>[0]) =>
    Effect.gen(function* () {
      const board = yield* read.getBoard(ctx.boardId);
      if (board === null) {
        return { _tag: "failed", error: "workflow board not found" } satisfies StepOutcome;
      }
      const trusted = yield* scriptTrust.isTrusted(board.projectId as ProjectId);
      if (!trusted) {
        return {
          _tag: "blocked",
          reason: "Project not trusted to run scripts",
        } satisfies StepOutcome;
      }
      return null;
    });

  const execute: StepExecutorShape["execute"] = (ctx) =>
    Effect.gen(function* () {
      const step = ctx.step;
      if (step.type === "approval") {
        return { _tag: "completed" } satisfies StepOutcome;
      }
      if (step.type === "script") {
        return yield* prepareWorktreeStep(
          ctx,
          (worktree) => scriptExecutor.execute({ ctx, step, worktree }),
          { preSetupGuard: () => scriptTrustGuard(ctx) },
        );
      }
      if (step.type === "merge") {
        return yield* prepareWorktreeStep(
          ctx,
          (worktree) =>
            merges.merge({
              ticketId: ctx.ticketId,
              repoRoot: worktree.repoRoot,
              worktreePath: worktree.path,
              worktreeRef: worktree.worktreeRef,
              step,
            }),
          // Merging needs no project dependencies installed in the worktree.
          { skipSetup: true },
        );
      }
      if (step.type === "pullRequest") {
        // PR steps need no project dependencies installed in the worktree —
        // they push/merge via gh. open and land share the same worktree prep.
        return yield* prepareWorktreeStep(
          ctx,
          (worktree) =>
            step.action === "open"
              ? pullRequests.open({
                  ticketId: ctx.ticketId,
                  stepRunId: ctx.stepRunId,
                  repoRoot: worktree.repoRoot,
                  worktreePath: worktree.path,
                  worktreeRef: worktree.worktreeRef,
                  step,
                })
              : pullRequests.land({
                  ticketId: ctx.ticketId,
                  stepRunId: ctx.stepRunId,
                  repoRoot: worktree.repoRoot,
                  worktreePath: worktree.path,
                  worktreeRef: worktree.worktreeRef,
                  step,
                }),
          { skipSetup: true },
        );
      }
      // Agent steps run the project's setup shell script via runSetup, which is
      // arbitrary code — the same trust surface the script-step guard protects.
      // But unlike a script step (whose whole purpose IS the untrusted script, so
      // it blocks), the agent itself is not the untrusted surface. So gate ONLY
      // the setup on project trust (gateSetupOnTrust): for an untrusted project
      // the setup script is SKIPPED (never executed) while the agent step still
      // runs. Merge/PR steps skip setup unconditionally.
      return yield* prepareWorktreeStep(ctx, (worktree) => executeAgentStep(ctx, worktree, step), {
        gateSetupOnTrust: true,
      });
    }).pipe(
      // Keep the executor total, but surface the underlying cause — a bare
      // "executor error" is undiagnosable from the board.
      Effect.catch((error) =>
        Effect.succeed<StepOutcome>({
          _tag: "failed",
          error: `executor error: ${executorErrorDetail(error)}`,
        }),
      ),
    );

  return { execute } satisfies StepExecutorShape;
});

export const RealStepExecutorLive = Layer.effect(StepExecutor, make);

export const WorktreePortLive = Layer.effect(
  WorktreePort,
  Effect.gen(function* () {
    const git = yield* GitWorkflowService;
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;

    const canonicalizeExistingPath = (value: string) =>
      fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));

    const repoRootForTicket = (ticketId: string) =>
      wrapSql(
        "ticket project lookup failed",
        sql<TicketProjectRow>`
          SELECT
            projects.workspace_root AS "repoRoot",
            projects.project_id AS "projectId"
          FROM projection_ticket AS ticket
          INNER JOIN projection_board AS board
            ON board.board_id = ticket.board_id
          INNER JOIN projection_projects AS projects
            ON projects.project_id = board.project_id
          WHERE ticket.ticket_id = ${ticketId}
          LIMIT 1
        `,
      ).pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          return row?.repoRoot
            ? Effect.succeed(row)
            : Effect.fail(
                new WorkflowEventStoreError({
                  message: `project repo root not found for ticket ${ticketId}`,
                }),
              );
        }),
      );

    const ensureWorktree: WorktreePortShape["ensureWorktree"] = (ticketId) =>
      Effect.gen(function* () {
        const project = yield* repoRootForTicket(ticketId as string);
        const repoRoot = yield* canonicalizeExistingPath(project.repoRoot);
        const projectId = project.projectId;
        const worktreeRef = `workflow/${ticketId}`;
        const refs = yield* git
          .listRefs({ cwd: TrimmedNonEmptyString.make(repoRoot) })
          .pipe(Effect.mapError(toExecutorError("worktree ref lookup failed")));
        const existing = refs.refs.find((ref) => !ref.isRemote && ref.name === worktreeRef);
        if (existing?.worktreePath) {
          return {
            repoRoot,
            worktreeRef,
            path: yield* canonicalizeExistingPath(existing.worktreePath),
            projectId,
          } satisfies WorktreeHandle;
        }

        const result = yield* git
          .createWorktree(
            existing
              ? {
                  cwd: TrimmedNonEmptyString.make(repoRoot),
                  refName: TrimmedNonEmptyString.make(worktreeRef),
                  path: null,
                }
              : {
                  cwd: TrimmedNonEmptyString.make(repoRoot),
                  refName: TrimmedNonEmptyString.make("HEAD"),
                  newRefName: TrimmedNonEmptyString.make(worktreeRef),
                  path: null,
                },
          )
          .pipe(Effect.mapError(toExecutorError("worktree creation failed")));

        return {
          repoRoot,
          worktreeRef: result.worktree.refName,
          path: yield* canonicalizeExistingPath(result.worktree.path),
          projectId,
        } satisfies WorktreeHandle;
      });

    return { ensureWorktree } satisfies WorktreePortShape;
  }),
);
