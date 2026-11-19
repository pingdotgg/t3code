// @effect-diagnostics effectFnOpportunity:off globalDate:off globalDateInEffect:off globalJsonInEffect:off runEffectInsideEffect:off nodeBuiltinImport:off - Thin wrapper over promise-based cores; spans come from withSpan, and wall-clock timestamps are user-facing state.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  ImproveError,
  MessageId,
  ThreadId,
  type ImproveJob,
  type ImproveRetryInput,
  type ImproveStartInput,
  type ModelSelection,
} from "@t3tools/contracts";
import {
  buildHandoffMessage,
  buildImproveRequest,
  cleanImprovedPrompt,
  summarizeForHandoff,
  type ImproveConversationMessage,
} from "@t3tools/shared/improvePrompt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export class ImproveService extends Context.Service<
  ImproveService,
  {
    readonly start: (input: ImproveStartInput) => Effect.Effect<ImproveJob, ImproveError>;
    readonly retry: (input: ImproveRetryInput) => Effect.Effect<ImproveJob, ImproveError>;
    readonly list: (sourceThreadId: ThreadId) => Effect.Effect<ReadonlyArray<ImproveJob>>;
    readonly dismiss: (requestId: string) => Effect.Effect<void>;
  }
>()("t3/improve/ImproveService") {}

const KEEP_JOBS = 200;

export function improvedThreadId(requestId: string): ThreadId {
  return ThreadId.make(`improve:${requestId}`);
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const file = NodePath.join(config.stateDir, "improve-jobs.json");
  const lock = yield* Semaphore.make(1);
  const jobs = new Map<string, ImproveJob>();

  yield* Effect.promise(async () => {
    try {
      const stored = JSON.parse(await NodeFSP.readFile(file, "utf8")) as { jobs?: ImproveJob[] };
      for (const job of stored.jobs ?? []) jobs.set(job.requestId, job);
    } catch {
      // No jobs yet.
    }
  });

  const save = Effect.promise(async () => {
    const list = [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-KEEP_JOBS);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(`${file}.tmp`, JSON.stringify({ version: 1, jobs: list }, null, 2));
    await NodeFSP.rename(`${file}.tmp`, file);
  });

  const put = (job: ImproveJob) =>
    Effect.gen(function* () {
      const updated = { ...job, updatedAt: new Date().toISOString() };
      jobs.set(job.requestId, updated);
      yield* save;
      return updated;
    });

  const label = (selection: ModelSelection) =>
    providers.getProviders.pipe(
      Effect.map((list) => {
        const provider = list.find((entry) => entry.instanceId === selection.instanceId);
        const model = provider?.models.find((entry) => entry.slug === selection.model);
        return `${provider?.displayName ?? selection.instanceId} · ${model?.name ?? selection.model}`;
      }),
    );

  const failure = (message: string) => new ImproveError({ message });

  const sourceContext = Effect.fn("ImproveService.sourceContext")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(() => failure("Could not read the session.")));
    if (shell === null) return yield* failure("That session no longer exists.");
    const { projection } = yield* threads
      .getThreadSnapshotWindow(threadId, { rowLimit: 80 })
      .pipe(Effect.mapError(() => failure("Could not read the session's messages.")));
    const messages: ImproveConversationMessage[] = projection.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role as "user" | "assistant", text: message.text }));
    const project = Option.getOrNull(yield* projects.getById(shell.projectId).pipe(Effect.orElseSucceed(() => Option.none())));
    return { shell, messages, project };
  });

  const rewrite = Effect.fn("ImproveService.rewrite")(function* (job: ImproveJob) {
    const { shell, messages, project } = yield* sourceContext(job.sourceThreadId);
    const cwd = shell.worktreePath ?? project?.workspaceRoot ?? config.baseDir;
    const generated = yield* textGeneration
      .generateTranscriptionPostProcessing({
        cwd,
        prompt: buildImproveRequest({
          draft: job.originalPrompt,
          threadTitle: shell.title,
          projectName: project?.title ?? null,
          workingDirectory: cwd,
          branch: shell.branch,
          messages,
          destinationLabel: yield* label(job.destination),
        }),
        modelSelection: job.improver,
      })
      .pipe(Effect.mapError((error) => failure(`The improving model failed: ${error.message}`)));
    const improved = cleanImprovedPrompt(generated.transcription);
    if (improved === "") return yield* failure("The improving model returned an empty prompt.");
    return { improved, summary: summarizeForHandoff(messages) };
  });

  const launch = Effect.fn("ImproveService.launch")(function* (job: ImproveJob) {
    const { shell } = yield* sourceContext(job.sourceThreadId);
    const text = buildHandoffMessage({
      improvedPrompt: job.improvedPrompt!,
      originalPrompt: job.originalPrompt,
      summary: job.contextSummary ?? "",
      sourceTitle: shell.title,
    });
    const threadId = improvedThreadId(job.requestId);
    yield* launches
      .launch({
        // One request id is one session: a retry replays this launch's receipt.
        commandId: CommandId.make(`improve:${job.requestId}:launch`),
        threadId,
        reuseExistingThread: true,
        projectId: shell.projectId,
        title: `Improved: ${shell.title}`.slice(0, 120),
        generateTitle: true,
        modelSelection: job.destination,
        // The new session keeps the source's approval behavior.
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        workspaceStrategy: shell.worktreePath
          ? { type: "existing_worktree", worktreePath: shell.worktreePath, ...(shell.branch ? { branch: shell.branch } : {}) }
          : { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`improve:${job.requestId}:message`),
          senderThreadId: job.sourceThreadId,
          text,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError((error: { readonly message?: string; readonly _tag: string }) => failure(`Could not open the new session: ${error.message ?? error._tag}`)));
    return threadId;
  });

  const runFrom = (job: ImproveJob, step: "rewrite" | "launch"): Effect.Effect<ImproveJob, ImproveError> =>
    Effect.gen(function* () {
      let current = job;
      if (step === "rewrite") {
        current = yield* put({ ...current, phase: "rewriting", error: null, failedStep: null });
        const rewritten = yield* rewrite(current).pipe(
          Effect.tapError((error) => put({ ...current, phase: "failed", failedStep: "rewrite", error: error.message })),
        );
        current = yield* put({ ...current, phase: "rewritten", improvedPrompt: rewritten.improved, contextSummary: rewritten.summary });
      }
      current = yield* put({ ...current, phase: "launching", error: null, failedStep: null });
      const threadId = yield* launch(current).pipe(
        Effect.tapError((error) => put({ ...current, phase: "failed", failedStep: "launch", error: error.message })),
      );
      return yield* put({ ...current, phase: "launched", newThreadId: threadId });
    });

  return ImproveService.of({
    start: (input) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = jobs.get(input.requestId);
          // The same request id never opens a second session.
          if (existing) return existing;
          const now = new Date().toISOString();
          const job: ImproveJob = {
            requestId: input.requestId,
            sourceThreadId: input.sourceThreadId,
            originalPrompt: input.prompt,
            improvedPrompt: null,
            contextSummary: null,
            improver: input.improver,
            destination: input.destination,
            phase: "rewriting",
            failedStep: null,
            error: null,
            newThreadId: null,
            createdAt: now,
            updatedAt: now,
          };
          jobs.set(job.requestId, job);
          return job;
        }),
      ).pipe(
        Effect.flatMap((job) => {
          const fresh = job.phase === "rewriting" && job.improvedPrompt === null && job.newThreadId === null;
          return fresh ? runFrom(job, "rewrite") : Effect.succeed(job);
        }),
        Effect.withSpan("ImproveService.start"),
      ),
    retry: (input) =>
      Effect.gen(function* () {
        const job = jobs.get(input.requestId);
        if (!job) return yield* failure("That /improve request is no longer kept. Run /improve again.");
        if (job.phase === "launched") return job;
        const updated: ImproveJob = {
          ...job,
          ...(input.improver ? { improver: input.improver } : {}),
          ...(input.destination ? { destination: input.destination } : {}),
          ...(input.improvedPrompt ? { improvedPrompt: input.improvedPrompt } : {}),
        };
        return yield* runFrom(updated, updated.improvedPrompt === null ? "rewrite" : "launch");
      }).pipe(Effect.withSpan("ImproveService.retry")),
    list: (sourceThreadId) =>
      Effect.sync(() =>
        [...jobs.values()].filter((job) => job.sourceThreadId === sourceThreadId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ),
    dismiss: (requestId) =>
      Effect.gen(function* () {
        jobs.delete(requestId);
        yield* save;
      }),
  });
});

export const layer = Layer.effect(ImproveService, make);
