import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_IMPORTED_HISTORY_MAX_MESSAGES,
  ORCHESTRATION_V2_IMPORTED_HISTORY_MAX_TEXT_BYTES,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ImportedHistoryMessage,
  type Project,
  ProjectId,
  type ThreadContinueOnEnvironmentInput,
  type ThreadContinueOnEnvironmentResult,
  type ThreadReceiveInput,
  ThreadReceiveResult,
} from "@t3tools/contracts";
import { withoutRemoteUrlCredentials } from "@t3tools/shared/cloneUrl";
import { newProjectFolderName } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** The receiving environment's tool that creates the continued thread. */
const RECEIVE_TOOL = "t3_thread_receive";

// The user asked for this move, so the only ceiling on the receiver is the link's Full access.
const RECEIVE_LIMITS = { runtimeMode: "full-access", interactionMode: "default" } as const;

// `git clone` names the remote it clones from `origin`.
const CLONE_REMOTE_NAME = "origin";

export class ThreadContinuationError extends Schema.TaggedError<ThreadContinuationError>()(
  "ThreadContinuationError",
  {
    reason: Schema.Literals([
      "link_not_full_access",
      "link_unavailable",
      "no_repository",
      "unpushed_work",
      "thread_running",
      "project_ambiguous",
      "receive_failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Wraps a lower failure under `reason`, keeping its message for the user. */
  static wrap(reason: ThreadContinuationError["reason"]) {
    return (cause: { readonly message: string }) =>
      new ThreadContinuationError({ reason, message: cause.message, cause });
  }
}

type TransferableMessage = Pick<OrchestrationV2ConversationMessage, "role" | "text" | "createdAt">;
type TransferMessage = TransferableMessage & { readonly role: "user" | "assistant" };

const textEncoder = new TextEncoder();
const textBytes = (message: TransferMessage) => textEncoder.encode(message.text).byteLength;

const isTransferMessage = (message: TransferableMessage): message is TransferMessage =>
  (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0;

/**
 * The part of a thread's transcript another environment gets: user and assistant text, the
 * first user message always, then the newest messages inside the imported history caps.
 * `omittedCount` counts the text messages left out.
 */
export function selectTranscriptForTransfer(messages: ReadonlyArray<TransferableMessage>) {
  const eligible = messages.filter(isTransferMessage);
  const firstUser = eligible.find((message) => message.role === "user");
  const others = eligible.filter((message) => message !== firstUser);
  const newestLimit = ORCHESTRATION_V2_IMPORTED_HISTORY_MAX_MESSAGES - (firstUser ? 1 : 0);
  const newest = others.slice(Math.max(0, others.length - newestLimit));
  let bytes = newest.reduce((total, message) => total + textBytes(message), 0);
  bytes += firstUser === undefined ? 0 : textBytes(firstUser);
  let dropped = 0;
  while (bytes > ORCHESTRATION_V2_IMPORTED_HISTORY_MAX_TEXT_BYTES && dropped < newest.length) {
    bytes -= textBytes(newest[dropped]!);
    dropped++;
  }
  const kept = [...(firstUser === undefined ? [] : [firstUser]), ...newest.slice(dropped)];
  return {
    messages: kept.map((message): OrchestrationV2ImportedHistoryMessage => ({
      role: message.role,
      text: message.text,
      createdAt: DateTime.formatIso(message.createdAt),
    })),
    omittedCount: eligible.length - kept.length,
  };
}

/**
 * Moves a thread to a linked environment. `send` runs on the machine the thread is on: it pushes
 * the thread's branch and asks the other machine to `receive` it, which finds or clones the
 * project and starts a thread on the same branch with the transcript so far.
 */
export class ThreadContinuation extends Context.Service<
  ThreadContinuation,
  {
    readonly send: (
      input: ThreadContinueOnEnvironmentInput,
    ) => Effect.Effect<
      ThreadContinueOnEnvironmentResult,
      | ThreadContinuationError
      | Orchestrator.OrchestratorV2Error
      | ProjectService.ProjectOperationError
    >;
    readonly receive: (
      input: ThreadReceiveInput,
    ) => Effect.Effect<ThreadReceiveResult, ThreadContinuationError>;
  }
>()("t3/peer/ThreadContinuation") {}

const receiveFailed = ThreadContinuationError.wrap("receive_failed");

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );

  const newCommandId = random.uuidV4().pipe(
    Effect.map((uuid) => CommandId.make(`thread-continuation:${uuid}`)),
    Effect.orDie,
  );

  /** A Full access link that has not expired, checked before any Git or network work. */
  const fullAccessLink = Effect.fn("ThreadContinuation.fullAccessLink")(function* (
    input: ThreadContinueOnEnvironmentInput,
  ) {
    const stored = yield* links
      .get(input.targetEnvironmentId)
      .pipe(Effect.mapError(ThreadContinuationError.wrap("link_unavailable")));
    if (Option.isNone(stored)) {
      return yield* new ThreadContinuationError({
        reason: "link_unavailable",
        message: "This environment has no link to that environment.",
      });
    }
    const link = stored.value;
    if (link.access !== "full-access") {
      return yield* new ThreadContinuationError({
        reason: "link_not_full_access",
        message: `Continuing a thread on ${link.label} needs a Full access link.`,
      });
    }
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
      return yield* new ThreadContinuationError({
        reason: "link_unavailable",
        message: `The link to ${link.label} expired. Link it again.`,
      });
    }
    return link;
  });

  /** The branch and the remote it is pushed to, pushing first when the user allowed it. */
  const pushedBranch = Effect.fn("ThreadContinuation.pushedBranch")(function* (
    input: ThreadContinueOnEnvironmentInput,
    target: { readonly cwd: string; readonly projectId: ProjectId },
  ) {
    const noRepository = ThreadContinuationError.wrap("no_repository");
    const local = yield* gitWorkflow
      .localStatus({ cwd: target.cwd })
      .pipe(Effect.mapError(noRepository));
    const branch = local.refName;
    if (!local.isRepo || branch === null) {
      return yield* new ThreadContinuationError({
        reason: "no_repository",
        message: "The thread's checkout is not on a Git branch.",
      });
    }
    const upstream = yield* gitWorkflow
      .upstreamDivergence(target.cwd)
      .pipe(Effect.mapError(noRepository));
    const hasUnpushedWork =
      local.hasWorkingTreeChanges || upstream === null || upstream.aheadCount > 0;
    if (hasUnpushedWork && !input.commitAndPush) {
      return yield* new ThreadContinuationError({
        reason: "unpushed_work",
        message: "The thread has changes that are not pushed. Commit and push them first.",
      });
    }
    if (hasUnpushedWork) {
      yield* gitWorkflow
        .runStackedAction({
          actionId: yield* newCommandId,
          cwd: target.cwd,
          action: "commit_push",
          threadId: input.threadId,
          projectId: target.projectId,
        })
        .pipe(Effect.mapError(ThreadContinuationError.wrap("unpushed_work")));
    }
    const pushed = hasUnpushedWork
      ? yield* gitWorkflow.upstreamDivergence(target.cwd).pipe(Effect.mapError(noRepository))
      : upstream;
    const remoteName = yield* git
      .readConfigValue(target.cwd, `branch.${branch}.remote`)
      .pipe(Effect.mapError(noRepository));
    const remoteUrl =
      remoteName === null
        ? null
        : yield* git
            .readConfigValue(target.cwd, `remote.${remoteName}.url`)
            .pipe(Effect.mapError(noRepository));
    const upstreamRef = pushed?.details.upstreamRef ?? null;
    if (remoteName === null || remoteUrl === null || upstreamRef === null) {
      return yield* new ThreadContinuationError({
        reason: "unpushed_work",
        message: `Branch ${branch} is not pushed to a remote.`,
      });
    }
    const remotePrefix = `${remoteName}/`;
    return {
      remoteName,
      remoteUrl: withoutRemoteUrlCredentials(remoteUrl),
      branch: upstreamRef.startsWith(remotePrefix)
        ? upstreamRef.slice(remotePrefix.length)
        : branch,
    };
  });

  const send: ThreadContinuation["Service"]["send"] = Effect.fn("ThreadContinuation.send")(
    function* (input) {
      const link = yield* fullAccessLink(input);
      const { thread, runs, messages } = yield* threads.getThreadRecords(
        input.threadId,
        ["runs", "messages"],
        { runStatuses: ThreadManagement.ACTIVE_RUN_STATUSES, messageRoles: ["user", "assistant"] },
      );
      if (runs.length > 0) {
        return yield* new ThreadContinuationError({
          reason: "thread_running",
          message: "The thread is still working. Stop it or wait until it is done.",
        });
      }
      const project = yield* projects.getById(thread.projectId);
      if (Option.isNone(project)) {
        return yield* new ThreadContinuationError({
          reason: "no_repository",
          message: "The thread has no project.",
        });
      }
      const cwd = thread.worktreePath ?? project.value.workspaceRoot;
      const identity = yield* repositoryIdentities.resolve(cwd);
      if (identity === null) {
        return yield* new ThreadContinuationError({
          reason: "no_repository",
          message: "The thread's project has no Git remote.",
        });
      }
      const pushed = yield* pushedBranch(input, { cwd, projectId: thread.projectId });
      const transcript = selectTranscriptForTransfer(messages);
      const receiveInput: ThreadReceiveInput = {
        repository: { remoteUrl: pushed.remoteUrl, canonicalKey: identity.canonicalKey },
        remoteName: pushed.remoteName,
        branch: pushed.branch,
        title: thread.title,
        modelSelection: thread.modelSelection,
        importedHistory: {
          ...transcript,
          source: { environmentId: hereId, threadId: thread.id, title: thread.title },
        },
        ...(input.message === undefined ? {} : { message: input.message }),
      };
      const received = yield* peers
        .call({
          environmentId: input.targetEnvironmentId,
          tool: RECEIVE_TOOL,
          arguments: receiveInput,
          limits: RECEIVE_LIMITS,
          success: ThreadReceiveResult,
        })
        .pipe(Effect.mapError(receiveFailed));
      // The thread there exists now, so a marker that fails here still returns its link.
      yield* threads
        .dispatch({
          type: "thread.moved.set",
          commandId: yield* newCommandId,
          threadId: thread.id,
          movedTo: {
            environmentId: input.targetEnvironmentId,
            threadId: received.threadId,
            title: received.title,
            label: link.label,
            movedAt: yield* DateTime.now,
          },
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not mark the thread as moved", error).pipe(
              Effect.annotateLogs({ threadId: thread.id }),
            ),
          ),
        );
      return {
        targetEnvironmentId: input.targetEnvironmentId,
        targetThreadId: received.threadId,
        title: received.title,
      };
    },
  );

  /** This environment's projects with the repository, in creation order. */
  const projectsWithRepository = Effect.fn("ThreadContinuation.projectsWithRepository")(function* (
    canonicalKey: string,
  ) {
    const matches: Array<Project> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: Effect.Success<ReturnType<ProjectService.ProjectService["Service"]["listPage"]>> =
        yield* projects.listPage({ cursor, limit: 100 }).pipe(Effect.mapError(receiveFailed));
      matches.push(
        ...page.projects.filter(
          (project) => project.repositoryIdentity?.canonicalKey === canonicalKey,
        ),
      );
      cursor = page.nextCursor;
    }
    return matches;
  });

  /** Clones the repository into the named projects folder and registers it. */
  const cloneProject = Effect.fn("ThreadContinuation.cloneProject")(function* (
    input: ThreadReceiveInput,
  ) {
    const name = input.repository.canonicalKey.split("/").at(-1) ?? input.repository.canonicalKey;
    const cloned = yield* repositories
      .cloneRepository(
        {
          remoteUrl: input.repository.remoteUrl,
          destinationPath: path.join(folders.namedProjectsRoot, newProjectFolderName(name)),
        },
        { timeoutMs: null },
      )
      .pipe(Effect.mapError((error) => receiveFailed({ message: error.detail })));
    const commandId = yield* newCommandId;
    return yield* projects
      .create({
        commandId,
        projectId: ProjectId.make(commandId),
        title: name,
        workspaceRoot: cloned.cwd,
      })
      .pipe(
        Effect.tapError(() => repositories.discardClone(cloned.cwd).pipe(Effect.ignore)),
        Effect.mapError(receiveFailed),
      );
  });

  /** The project with the repository here, cloned when there is none, and its remote's name. */
  const receivingProject = Effect.fn("ThreadContinuation.receivingProject")(function* (
    input: ThreadReceiveInput,
  ) {
    const matches = yield* projectsWithRepository(input.repository.canonicalKey);
    if (matches.length > 1) {
      return yield* new ThreadContinuationError({
        reason: "project_ambiguous",
        message: `Several projects here have this repository: ${matches.map((project) => project.title).join(", ")}. Remove all but one, then try again.`,
      });
    }
    const [match] = matches;
    if (match !== undefined) return { project: match, remoteName: input.remoteName };
    return { project: yield* cloneProject(input), remoteName: CLONE_REMOTE_NAME };
  });

  /** The sender's model when this environment has that provider, else the project's default. */
  const receivingModes = Effect.fn("ThreadContinuation.receivingModes")(function* (
    input: ThreadReceiveInput,
    project: Project,
  ) {
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(Effect.mapError(receiveFailed)),
      project.id,
      project,
    ).settings;
    const providers = yield* providerRegistry.getProviders;
    const requested = input.modelSelection;
    const hasRequestedProvider =
      requested !== undefined &&
      providers.some(
        (provider) =>
          provider.instanceId === requested.instanceId && provider.enabled && provider.installed,
      );
    const modelSelection = hasRequestedProvider
      ? requested
      : resolveNewThreadModelSelection({
          defaultSelection: settings.defaultModelSelection,
          fallbackSelection: settings.fallbackModelSelection,
          providers,
          settings,
          projectId: project.id,
          now: DateTime.toEpochMillis(yield* DateTime.now),
        }).selection;
    if (modelSelection === null) {
      return yield* new ThreadContinuationError({
        reason: "receive_failed",
        message: "This environment has no default model. Pick one in Settings.",
      });
    }
    return { modelSelection, runtimeMode: settings.defaultRuntimeMode };
  });

  /**
   * Thread creation cannot carry imported history and a first message together, so the message
   * goes in a run of its own that prepares the worktree before it starts, as a launch does for a
   * first message its thread claim did not carry.
   */
  const startWithMessage = Effect.fn("ThreadContinuation.startWithMessage")(function* (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadReceiveResult["threadId"];
    readonly text: string;
    readonly modelSelection: NonNullable<ThreadReceiveInput["modelSelection"]>;
    readonly workspaceStrategy: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
  }) {
    const commandId = CommandId.make(`${input.commandId}:message`);
    const dispatched = yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId,
        threadId: input.threadId,
        messageId: MessageId.make(commandId),
        text: input.text,
        attachments: [],
        modelSelection: input.modelSelection,
        dispatchMode: { type: "defer_start", workspaceStrategy: input.workspaceStrategy },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(receiveFailed));
    const runCreated = dispatched.storedEvents.find(
      (stored) => stored.event.type === "run.created",
    );
    if (runCreated?.event.type !== "run.created") {
      return yield* new ThreadContinuationError({
        reason: "receive_failed",
        message: "The message was accepted without a run.",
      });
    }
    yield* launches.prepareRun({
      commandId,
      threadId: input.threadId,
      runId: runCreated.event.payload.id,
    });
  });

  const receive: ThreadContinuation["Service"]["receive"] = Effect.fn("ThreadContinuation.receive")(
    function* (input) {
      const { project, remoteName } = yield* receivingProject(input);
      const { modelSelection, runtimeMode } = yield* receivingModes(input, project);
      const worktree: ThreadLaunch.ThreadLaunchWorkspaceStrategy = {
        type: "worktree",
        baseRef: `${remoteName}/${input.branch}`,
        branch: input.branch,
        startFromOrigin: true,
      };
      // Launch accepts worktree failures and reports them inside the thread; check first so they
      // come back to the sender and no thread is left behind.
      yield* launches
        .checkWorktreeBase({ projectId: project.id, workspaceStrategy: worktree })
        .pipe(Effect.mapError(receiveFailed));
      const commandId = yield* newCommandId;
      const launched = yield* launches
        .launch({
          commandId,
          projectId: project.id,
          title: input.title,
          titleRenamed: true,
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          workspaceStrategy: input.message === undefined ? worktree : { type: "root" },
          importedHistory: input.importedHistory,
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(receiveFailed));
      if (input.message !== undefined) {
        yield* startWithMessage({
          commandId,
          threadId: launched.threadId,
          text: input.message,
          modelSelection,
          workspaceStrategy: worktree,
        });
      }
      return {
        threadId: launched.threadId,
        projectId: project.id,
        title: launched.projection.thread.title,
      };
    },
  );

  return ThreadContinuation.of({ send, receive });
});

export const layer = Layer.effect(ThreadContinuation, make);
