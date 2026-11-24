import {
  CommandId,
  EventId,
  MessageId,
  THREAD_MOVE_MAX_HISTORY_BYTES,
  ThreadMoveError,
  TurnItemId,
  isRuntimeModeAbove,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ProjectedTurnItem,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
  type ThreadMoveGit,
  type ThreadMoveImportInput,
  type ThreadMoveImportResult,
  type ThreadMoveMessage,
  type ThreadMoveSnapshot,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const EVENT_PREFIX = "thread-move:v1";

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The first request and the newest history that fit `maxBytes`, in their original order. */
export function selectMoveHistory(
  messages: ReadonlyArray<ThreadMoveMessage>,
  maxBytes: number = THREAD_MOVE_MAX_HISTORY_BYTES,
): { readonly messages: ReadonlyArray<ThreadMoveMessage>; readonly omittedMessageCount: number } {
  const firstUser = messages.findIndex((message) => message.role === "user");
  let budget = maxBytes;
  const kept = new Set<number>();
  if (firstUser !== -1 && utf8Bytes(messages[firstUser]!.text) <= budget) {
    kept.add(firstUser);
    budget -= utf8Bytes(messages[firstUser]!.text);
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    const size = utf8Bytes(messages[index]!.text);
    if (size > budget) break;
    kept.add(index);
    budget -= size;
  }
  return {
    messages: messages.filter((_, index) => kept.has(index)),
    omittedMessageCount: messages.length - kept.size,
  };
}

export function historyFromTurnItems(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<ThreadMoveMessage> {
  return items.flatMap(({ visibility, item }) => {
    if (visibility === "synthetic") return [];
    if (item.type !== "user_message" && item.type !== "assistant_message") return [];
    if (item.text.trim() === "") return [];
    const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
    return [
      item.type === "user_message"
        ? {
            role: "user" as const,
            text: item.text,
            createdAt,
            ...(item.createdBy === "user"
              ? {}
              : { createdBy: item.createdBy, creationSource: item.creationSource }),
          }
        : { role: "assistant" as const, text: item.text, createdAt },
    ];
  });
}

/** What the target already has of the moved branch. */
export type TargetBranchCheckout =
  | { readonly type: "absent" }
  | { readonly type: "unchecked" }
  | { readonly type: "checked-out"; readonly worktreePath: string };

export type MoveWorkspacePlan =
  | {
      readonly type: "carry";
      readonly branch: string;
      readonly strategy: ThreadLaunchService.ThreadLaunchWorkspaceStrategy;
      /** Reuses a checkout already on the target, which may sit at another commit. */
      readonly reusedCheckout: boolean;
      /** The target must first add a worktree for the existing local branch. */
      readonly addWorktree: boolean;
    }
  | { readonly type: "default"; readonly reason: "no-git" | "not-pushed" };

/** Where the moved thread works, from the source's branch and what the target already has of it. */
export function planMoveWorkspace(input: {
  readonly git: ThreadMoveGit | null;
  readonly workspaceRoot: string;
  readonly targetBranch: TargetBranchCheckout;
}): MoveWorkspacePlan {
  const { git } = input;
  if (git === null) return { type: "default", reason: "no-git" };
  if (git.remoteBranch === null) return { type: "default", reason: "not-pushed" };
  const branch = git.branch;
  switch (input.targetBranch.type) {
    case "checked-out": {
      const inRoot =
        normalizeProjectPathForComparison(input.targetBranch.worktreePath) ===
        normalizeProjectPathForComparison(input.workspaceRoot);
      return {
        type: "carry",
        branch,
        strategy: inRoot
          ? { type: "root", branch }
          : { type: "existing_worktree", worktreePath: input.targetBranch.worktreePath, branch },
        reusedCheckout: true,
        addWorktree: false,
      };
    }
    case "unchecked":
      return {
        type: "carry",
        branch,
        // The caller swaps in the worktree it adds for the existing branch.
        strategy: { type: "root", branch },
        reusedCheckout: true,
        addWorktree: true,
      };
    case "absent":
      return {
        type: "carry",
        branch,
        strategy: { type: "worktree", baseRef: git.remoteBranch, branch, startFromOrigin: true },
        reusedCheckout: false,
        addWorktree: false,
      };
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The notice the moved thread opens with: where it came from and what stayed behind. */
function moveArrivalNotice(input: {
  readonly snapshot: Pick<
    ThreadMoveSnapshot,
    "sourceEnvironmentLabel" | "omittedMessageCount" | "git"
  >;
  readonly outcome:
    | { readonly type: "carried"; readonly branch: string; readonly headMismatch: string | null }
    | { readonly type: "not-carried"; readonly reason: "no-git" | "not-pushed" | "not-on-remote" };
  /** The model the thread switched to, when this machine cannot run its own. */
  readonly switchedModel: string | null;
}): string {
  const { snapshot, outcome } = input;
  const source = snapshot.sourceEnvironmentLabel;
  const parts = [
    `Moved from ${source}. The conversation came along; tool activity, attachments and reasoning stay with the original thread there.`,
  ];
  if (input.switchedModel !== null) {
    parts.push(
      `The thread's model is not available here, so it continues with ${input.switchedModel}.`,
    );
  }
  if (snapshot.omittedMessageCount > 0) {
    parts.push(
      `${plural(snapshot.omittedMessageCount, "older message was", "older messages were")} left behind to keep the move small.`,
    );
  }
  const git = snapshot.git;
  if (outcome.type === "carried") {
    parts.push(`Working on ${outcome.branch} as pushed to the remote.`);
    if (outcome.headMismatch !== null) {
      parts.push(
        `The checkout here is not at the moved commit ${outcome.headMismatch.slice(0, 12)}; pull before continuing.`,
      );
    }
  } else if (git !== null && outcome.reason === "not-pushed") {
    parts.push(`${git.branch} was not pushed, so its code did not move.`);
  } else if (git !== null && outcome.reason === "not-on-remote") {
    parts.push(`${git.branch} was not found on this machine's remote, so its code did not move.`);
  }
  if (git !== null) {
    const leftBehind = [
      ...(outcome.type === "carried" && git.unpushedCommitCount > 0
        ? [plural(git.unpushedCommitCount, "unpushed commit", "unpushed commits")]
        : []),
      ...(git.uncommittedFileCount > 0
        ? [plural(git.uncommittedFileCount, "uncommitted file", "uncommitted files")]
        : []),
    ];
    if (leftBehind.length > 0) parts.push(`${leftBehind.join(" and ")} stayed on ${source}.`);
  }
  return parts.join(" ");
}

/**
 * The moved thread's model when this environment cannot run the source's instance and its
 * project names no default: the same model under another instance, else any ready provider.
 */
export function fallbackMoveModel(
  wanted: ModelSelection,
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "enabled" | "installed" | "status" | "models">
  >,
): ModelSelection | null {
  const usable = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.models.length > 0,
  );
  const sameModel = usable.find((provider) =>
    provider.models.some((model) => model.slug === wanted.model),
  );
  if (sameModel !== undefined) return { instanceId: sameModel.instanceId, model: wanted.model };
  const first = usable[0];
  return first === undefined
    ? null
    : { instanceId: first.instanceId, model: first.models[0]!.slug };
}

const moveError = (reason: ThreadMoveError["reason"], detail: string) =>
  new ThreadMoveError({ reason, detail });

const failed = (what: string) => (cause: unknown) =>
  moveError(
    "failed",
    `${what}: ${cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause)}`,
  );

export interface ThreadMoveCaller {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /** An agent's own modes cap the thread it moves in. */
  readonly runtimeModeCeiling?: RuntimeMode | undefined;
  /** The linked environment an agent moved it from, which the new thread carries. */
  readonly linkOrigin?: OrchestrationV2LinkOrigin | undefined;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const eventSink = yield* EventSink.EventSinkV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  const requireThread = Effect.fn("ThreadMoveService.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(failed("Read thread")));
    if (shell === null || shell.deletedAt !== null) {
      return yield* moveError("thread-not-found", `Thread ${threadId} was not found.`);
    }
    return shell;
  });

  const requireProject = Effect.fn("ThreadMoveService.requireProject")(function* (
    projectId: ProjectId,
  ) {
    return yield* projects.getById(projectId).pipe(
      Effect.mapError(failed("Read project")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(moveError("project-not-found", `Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

  const readGit = Effect.fn("ThreadMoveService.readGit")(function* (cwd: string) {
    const status = yield* git.statusDetails(cwd);
    if (!status.isRepo || status.branch === null) return null;
    const branch = status.branch;
    const merge = status.hasUpstream
      ? yield* git.readConfigValue(cwd, `branch.${branch}.merge`)
      : null;
    const remoteBranch = merge?.replace(/^refs\/heads\//, "").trim() || null;
    const headCommit = yield* git.resolveCommit({ cwd, revision: "HEAD" }).pipe(
      Effect.map((resolved) => resolved.commitSha),
      Effect.orElseSucceed(() => null),
    );
    return {
      branch,
      remoteBranch,
      headCommit,
      unpushedCommitCount: remoteBranch === null ? status.aheadOfDefaultCount : status.aheadCount,
      uncommittedFileCount: status.workingTree.files.length,
    } satisfies ThreadMoveGit;
  });

  const exportThread = Effect.fn("ThreadMoveService.exportThread")(function* (threadId: ThreadId) {
    const shell = yield* requireThread(threadId);
    const { projection } = yield* threads
      .getThreadSnapshot(threadId)
      .pipe(Effect.mapError(failed("Read thread history")));
    if (projection.runs.some(ThreadManagement.isActiveRun)) {
      return yield* moveError("thread-running", "Stop the thread before moving it.");
    }
    const project = yield* requireProject(shell.projectId);
    const thread = projection.thread;
    const gitState = yield* readGit(thread.worktreePath ?? project.workspaceRoot).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read the moved thread's Git state", { threadId, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
    const history = selectMoveHistory(historyFromTurnItems(projection.visibleTurnItems));
    const descriptor = yield* environment.getDescriptor;
    return {
      sourceThreadId: thread.id,
      sourceEnvironmentLabel: descriptor.label,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      messages: history.messages,
      omittedMessageCount: history.omittedMessageCount,
      pullRequests: (thread.pullRequests ?? []).map(({ watch: _watch, ...link }) => link),
      git: gitState,
    } satisfies ThreadMoveSnapshot;
  });

  const targetBranchCheckout = Effect.fn("ThreadMoveService.targetBranchCheckout")(function* (
    workspaceRoot: string,
    branch: string,
  ) {
    const { refs } = yield* git.listRefs({
      cwd: workspaceRoot,
      refKind: "local",
      query: branch,
      refresh: true,
    });
    const local = refs.find((ref) => ref.name === branch && ref.isRemote !== true);
    if (local === undefined) return { type: "absent" } as const;
    return local.worktreePath === null
      ? ({ type: "unchecked" } as const)
      : ({ type: "checked-out", worktreePath: local.worktreePath } as const);
  });

  const defaultStrategy = Effect.fn("ThreadMoveService.defaultStrategy")(function* (input: {
    readonly workspaceRoot: string;
    readonly envMode: "local" | "worktree";
  }) {
    if (input.envMode === "local") return { type: "root" } as const;
    const rootBranch = yield* git.statusDetailsLocal(input.workspaceRoot).pipe(
      Effect.map((status) => (status.isRepo ? status.branch : null)),
      Effect.orElseSucceed(() => null),
    );
    return rootBranch === null
      ? ({ type: "root" } as const)
      : ({ type: "worktree", baseRef: rootBranch } as const);
  });

  const importThread = Effect.fn("ThreadMoveService.importThread")(function* (
    input: ThreadMoveImportInput,
    caller: ThreadMoveCaller,
  ) {
    const { snapshot } = input;
    const historyBytes = snapshot.messages.reduce(
      (sum, message) => sum + utf8Bytes(message.text),
      0,
    );
    if (historyBytes > THREAD_MOVE_MAX_HISTORY_BYTES) {
      return yield* moveError(
        "history-too-large",
        `The moved history is ${historyBytes} bytes; at most ${THREAD_MOVE_MAX_HISTORY_BYTES} can move.`,
      );
    }
    const project = yield* requireProject(input.projectId);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(failed("Read settings")),
    );
    const projectFile = Option.getOrNull(yield* projectFiles.load(project.workspaceRoot));
    // With the project file, unset settings resolve to its values and then the built-in defaults.
    const projectSettings = resolveProjectSettings(
      settings,
      project.id,
      project,
      projectFile,
    ).settings;

    const providers = yield* providerRegistry.getProviders;
    const modelSelection = (yield* threads.isProviderInstanceEnabledForProject({
      projectId: project.id,
      instanceId: snapshot.modelSelection.instanceId,
    }))
      ? snapshot.modelSelection
      : (projectSettings.defaultModelSelection ??
        fallbackMoveModel(snapshot.modelSelection, providers));
    if (modelSelection === null) {
      return yield* moveError(
        "failed",
        `No provider here can run the moved thread. Set one up in Settings, then move it again.`,
      );
    }
    const switchedModel =
      modelSelection === snapshot.modelSelection
        ? null
        : (providers
            .find((provider) => provider.instanceId === modelSelection.instanceId)
            ?.models.find((model) => model.slug === modelSelection.model)?.name ??
          modelSelection.model);
    const runtimeMode = [
      settingsService.managedPolicy?.limits?.maxRuntimeMode,
      caller.runtimeModeCeiling,
    ]
      .filter((ceiling): ceiling is RuntimeMode => ceiling !== undefined)
      .reduce(
        (mode, ceiling) => (isRuntimeModeAbove(mode, ceiling) ? ceiling : mode),
        snapshot.runtimeMode,
      );

    const workspaceRoot = project.workspaceRoot;
    const targetBranch =
      snapshot.git?.remoteBranch == null
        ? ({ type: "absent" } as const)
        : yield* targetBranchCheckout(workspaceRoot, snapshot.git.branch).pipe(
            Effect.orElseSucceed(() => ({ type: "absent" }) as const),
          );
    const plan = planMoveWorkspace({ git: snapshot.git, workspaceRoot, targetBranch });

    let carriedBranch: string | null = null;
    let notCarriedReason: "no-git" | "not-pushed" | "not-on-remote" | null = null;
    let strategy: ThreadLaunchService.ThreadLaunchWorkspaceStrategy;
    let reusedCheckout = false;
    if (plan.type === "default") {
      notCarriedReason = plan.reason;
      strategy = yield* defaultStrategy({
        workspaceRoot,
        envMode: projectSettings.defaultThreadEnvMode,
      });
    } else if (plan.addWorktree) {
      const added = yield* git
        .createWorktree({ cwd: workspaceRoot, refName: plan.branch, path: null })
        .pipe(Effect.mapError(failed(`Check out ${plan.branch}`)));
      strategy = {
        type: "existing_worktree",
        worktreePath: added.worktree.path,
        branch: plan.branch,
      };
      carriedBranch = plan.branch;
      reusedCheckout = true;
    } else if (plan.strategy.type === "worktree") {
      const baseCheck = yield* Effect.exit(
        launcher.checkWorktreeBase({
          projectId: project.id,
          workspaceStrategy: plan.strategy,
          commandId: input.commandId,
        }),
      );
      if (baseCheck._tag === "Success") {
        strategy = plan.strategy;
        carriedBranch = plan.branch;
      } else {
        notCarriedReason = "not-on-remote";
        strategy = yield* defaultStrategy({
          workspaceRoot,
          envMode: projectSettings.defaultThreadEnvMode,
        });
      }
    } else {
      strategy = plan.strategy;
      carriedBranch = plan.branch;
      reusedCheckout = plan.reusedCheckout;
    }

    const headMismatch =
      reusedCheckout && carriedBranch !== null && snapshot.git?.headCommit != null
        ? yield* git
            .resolveCommit({
              cwd: strategy.type === "existing_worktree" ? strategy.worktreePath : workspaceRoot,
              revision: "HEAD",
            })
            .pipe(
              Effect.map((resolved) =>
                resolved.commitSha === snapshot.git?.headCommit ? null : snapshot.git!.headCommit,
              ),
              Effect.orElseSucceed(() => null),
            )
        : null;

    const launched = yield* launcher
      .launch({
        commandId: input.commandId,
        projectId: project.id,
        title: snapshot.title.trim() === "" ? "Moved thread" : snapshot.title,
        titleRenamed: true,
        modelSelection,
        runtimeMode,
        interactionMode: snapshot.interactionMode,
        workspaceStrategy: strategy,
        createdBy: caller.createdBy,
        creationSource: caller.creationSource,
        ...(caller.linkOrigin === undefined ? {} : { linkOrigin: caller.linkOrigin }),
      })
      .pipe(Effect.mapError(failed("Create the moved thread")));
    const threadId = launched.threadId;

    const notice = moveArrivalNotice({
      snapshot,
      outcome:
        carriedBranch !== null
          ? { type: "carried", branch: carriedBranch, headMismatch }
          : { type: "not-carried", reason: notCarriedReason ?? "no-git" },
      switchedModel,
    });
    // Worktree preparation writes the thread row in the background; re-read under the lock.
    yield* threadCommands
      .withLock(
        threadId,
        Effect.gen(function* () {
          const { thread } = yield* threads.getThreadRecords(threadId, []);
          if (thread.historyOrigin === "v1_import") return;
          const now = yield* DateTime.now;
          const historyEvents = snapshot.messages.flatMap((message, index) =>
            moveMessageEvents({ threadId, index, message }),
          );
          const noticeItemId = TurnItemId.make(`${EVENT_PREFIX}:notice:${threadId}`);
          yield* eventSink.write({
            events: [
              ...historyEvents,
              {
                id: EventId.make(noticeItemId),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: noticeItemId,
                  threadId,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: snapshot.messages.length + 1,
                  status: "completed",
                  title: "Thread moved",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "system_notice",
                  message: notice,
                },
              },
              {
                id: EventId.make(`${EVENT_PREFIX}:thread:${threadId}:history`),
                type: "thread.metadata-updated",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                // Run-less history: the first turn hands it to the provider as a portable handoff.
                payload: {
                  ...thread,
                  historyOrigin: "v1_import",
                  ...(snapshot.pullRequests.length === 0
                    ? {}
                    : { pullRequests: snapshot.pullRequests }),
                },
              },
            ],
          });
        }),
      )
      .pipe(Effect.mapError(failed("Copy the thread's history")));

    return { threadId, carriedBranch } satisfies ThreadMoveImportResult;
  });

  const completeMove = Effect.fn("ThreadMoveService.completeMove")(function* (input: {
    readonly threadId: ThreadId;
    readonly targetEnvironmentLabel: string;
  }) {
    const shell = yield* requireThread(input.threadId);
    if (shell.archivedAt !== null) return;
    const { runs } = yield* threads
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(Effect.mapError(failed("Read thread")));
    if (runs.some(ThreadManagement.isActiveRun)) {
      return yield* moveError("thread-running", "Stop the thread before moving it.");
    }
    const lastRun = runs.reduce<(typeof runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
    const now = yield* DateTime.now;
    // On the last run, the notice lands after that run's items, at the end of the thread.
    const noticeId =
      lastRun === null
        ? TurnItemId.make(`${EVENT_PREFIX}:moved-away:${input.threadId}:${yield* randomUuidV4}`)
        : ids.derive.runSignalTurnItem({ runId: lastRun.id, signal: "thread-moved" });
    const eventId = yield* ids.allocate
      .event({ threadId: input.threadId })
      .pipe(Effect.mapError(failed("Record the move")));
    yield* eventSink
      .write({
        events: [
          {
            id: eventId,
            type: "turn-item.updated",
            threadId: input.threadId,
            ...(lastRun === null ? {} : { runId: lastRun.id }),
            occurredAt: now,
            payload: {
              id: noticeId,
              threadId: input.threadId,
              runId: lastRun?.id ?? null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              // EventSink allocates the real position, after the run's existing items.
              ordinal: 0,
              status: "completed",
              title: "Thread moved",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "system_notice",
              message: `Moved to ${input.targetEnvironmentLabel}. The conversation continued there; this thread keeps its full history.`,
            },
          },
        ],
      })
      .pipe(Effect.mapError(failed("Record the move")));
    yield* threads
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`${EVENT_PREFIX}:archive:${yield* randomUuidV4}`),
        threadId: input.threadId,
      })
      .pipe(Effect.mapError(failed("Archive the moved thread")));
  });

  return { exportThread, importThread, completeMove };
});

function moveMessageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: ThreadMoveMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${EVENT_PREFIX}:${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(`${EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`);
  const at = DateTime.makeUnsafe(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.index + 1,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const isUser = input.message.role === "user";
  return [
    {
      id: EventId.make(`${EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: {
        createdBy: isUser ? (input.message.createdBy ?? "user") : "agent",
        creationSource: input.message.creationSource ?? "server",
        id: messageId,
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        role: input.message.role,
        text: input.message.text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    },
    {
      id: EventId.make(turnItemId),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: isUser
        ? {
            ...common,
            createdBy: input.message.createdBy ?? "user",
            creationSource: input.message.creationSource ?? "server",
            type: "user_message",
            messageId,
            inputIntent: "turn_start",
            text: input.message.text,
            attachments: [],
          }
        : {
            ...common,
            type: "assistant_message",
            messageId,
            text: input.message.text,
            streaming: false,
          },
    },
  ];
}

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/ThreadMoveService") {}

export const layer = Layer.effect(ThreadMoveService, make);
