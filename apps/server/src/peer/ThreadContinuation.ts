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
  ThreadId,
  type ThreadReceiveInput,
  ThreadReceiveResult,
} from "@t3tools/contracts";
import { withoutRemoteUrlCredentials } from "@t3tools/shared/cloneUrl";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** The receiving environment's tool that creates the continued thread. */
const RECEIVE_TOOL = "t3_thread_receive";

// The user asked for this move, so the only ceiling on the receiver is the link's Full access.
const USER_LIMITS = { runtimeMode: "full-access", interactionMode: "default" } as const;

// `git clone` names the remote it clones from `origin`, and an identity's `origin` is that remote.
const ORIGIN = "origin";

/** An agent that asks for a move. Its limits go with the call, as they do for forwarded tools. */
export interface ThreadContinuationAgent {
  readonly limits: PeerMcpClient.PeerCallLimits;
  /** The agent's own thread here, if it runs in one. */
  readonly threadId: ThreadId | undefined;
}

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
      "branch_conflict",
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
  const keptSet = new Set([
    ...(firstUser === undefined ? [] : [firstUser]),
    ...newest.slice(dropped),
  ]);
  const kept = eligible.filter((message) => keptSet.has(message));
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
 * The repository key of a remote. The identity resolved SSH host aliases for the remotes it
 * names, so its keys win for those; other remotes are keyed from their URL, as it keys them.
 */
const remoteRepositoryKey = (
  identity: Project["repositoryIdentity"],
  remote: { readonly name: string; readonly url: string },
) =>
  identity?.locator.remoteName === remote.name
    ? identity.canonicalKey
    : remote.name === ORIGIN && identity?.origin !== undefined
      ? identity.origin.canonicalKey
      : sourceControlDefinitions.repositoryKeyFromRemote(remote.url);

/**
 * Moves a thread to a linked environment. `send` runs on the machine the thread is on: it pushes
 * the thread's branch and asks the other machine to `receive` it, which finds or clones the
 * project and starts a thread on the same branch with the transcript so far.
 */
export class ThreadContinuation extends Context.Service<
  ThreadContinuation,
  {
    /** Without `agent`, the user asked: the move gets the link's Full access. */
    readonly send: (
      input: ThreadContinueOnEnvironmentInput,
      agent?: ThreadContinuationAgent,
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
  const crypto = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );

  const newCommandId = random.uuidV4().pipe(
    Effect.map((uuid) => CommandId.make(`thread-continuation:${uuid}`)),
    Effect.orDie,
  );

  /** Every retry of one send has the same id: the thread, at its newest message. */
  const sendRequestId = (threadId: ThreadId, newestMessageId: MessageId | undefined) =>
    crypto
      .digest(Digest.sha256, textEncoder.encode(`${hereId}\n${threadId}\n${newestMessageId ?? ""}`))
      .pipe(
        Effect.map((digest) => `continue:${Hex.encode(digest)}`),
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
    function* (input, agent) {
      const link = yield* fullAccessLink(input);
      const { thread, runs, messages } = yield* threads.getThreadRecords(
        input.threadId,
        ["runs", "messages"],
        { runStatuses: ThreadManagement.ACTIVE_RUN_STATUSES, messageRoles: ["user", "assistant"] },
      );
      // The agent of the thread may move it: the run that is working is the agent's own.
      const movesItself = agent?.threadId === thread.id;
      if (runs.length > 0 && !movesItself) {
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
      const pushRemote = { name: pushed.remoteName, url: pushed.remoteUrl };
      const receiveInput: ThreadReceiveInput = {
        repository: {
          remoteUrl: pushed.remoteUrl,
          canonicalKey: remoteRepositoryKey(identity, pushRemote),
        },
        remoteName: pushed.remoteName,
        requestId: yield* sendRequestId(thread.id, messages.at(-1)?.id),
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
          limits: agent?.limits ?? USER_LIMITS,
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

  /** This environment's projects with the repository, as upstream or as origin fork. */
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
          ({ repositoryIdentity: identity }) =>
            identity?.canonicalKey === canonicalKey ||
            identity?.origin?.canonicalKey === canonicalKey,
        ),
      );
      cursor = page.nextCursor;
    }
    return matches;
  });

  /** The project's remote for the repository; the sender's name for it can differ. */
  const remoteForRepository = Effect.fn("ThreadContinuation.remoteForRepository")(function* (
    project: Project,
    canonicalKey: string,
  ) {
    const root = project.workspaceRoot;
    const listed = yield* git
      .execute({ operation: "ThreadContinuation.receive.remotes", cwd: root, args: ["remote"] })
      .pipe(Effect.mapError(receiveFailed));
    const names = listed.stdout.split(/\r?\n/u).filter((name) => name.length > 0);
    for (const name of names) {
      const url = yield* git
        .readConfigValue(root, `remote.${name}.url`)
        .pipe(Effect.mapError(receiveFailed));
      const pointsAtRepository =
        url !== null &&
        remoteRepositoryKey(project.repositoryIdentity, { name, url }) === canonicalKey;
      if (pointsAtRepository) return name;
    }
    return yield* new ThreadContinuationError({
      reason: "receive_failed",
      message: `No remote of ${project.title} here points at ${canonicalKey}. Add one, then try again.`,
    });
  });

  /** Clones the repository into a free folder for named projects and registers it. */
  const cloneProject = Effect.fn("ThreadContinuation.cloneProject")(function* (
    input: ThreadReceiveInput,
  ) {
    const name = input.repository.canonicalKey.split("/").at(-1) ?? input.repository.canonicalKey;
    const folder = yield* folders.claimNamedFolder(name).pipe(Effect.mapError(receiveFailed));
    const cloned = yield* repositories
      .cloneRepository(
        { remoteUrl: input.repository.remoteUrl, destinationPath: folder },
        { timeoutMs: null },
      )
      .pipe(
        // The folder was claimed empty, so all it holds is from the failed clone.
        Effect.tapError(() => fileSystem.remove(folder, { recursive: true }).pipe(Effect.ignore)),
        Effect.mapError((error) => receiveFailed({ message: error.detail })),
      );
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

  /** The one project here with the repository, or null when it must be cloned. */
  const existingProject = Effect.fn("ThreadContinuation.existingProject")(function* (
    canonicalKey: string,
  ) {
    const matches = yield* projectsWithRepository(canonicalKey);
    if (matches.length > 1) {
      return yield* new ThreadContinuationError({
        reason: "project_ambiguous",
        message: `Several projects here have this repository: ${matches.map((project) => project.title).join(", ")}. Remove all but one, then try again.`,
      });
    }
    return matches[0] ?? null;
  });

  /**
   * The sender's model when this environment has that provider, else the project's default, or
   * the environment's default for a project that is not cloned yet.
   */
  const receivingModes = Effect.fn("ThreadContinuation.receivingModes")(function* (
    input: ThreadReceiveInput,
    project: Project | null,
  ) {
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(Effect.mapError(receiveFailed)),
      project?.id ?? null,
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
          projectId: project?.id ?? null,
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

  /** The checkout here that has `branch`, and whether it is the project's main checkout. */
  const branchCheckout = Effect.fn("ThreadContinuation.branchCheckout")(function* (
    root: string,
    branch: string,
  ) {
    const worktreePaths = yield* git.listWorktreePaths(root);
    for (const [index, worktreePath] of worktreePaths.entries()) {
      const current = yield* git.readCurrentBranch(worktreePath);
      // Git lists the main checkout first. Paths are not compared because Windows short names
      // can spell the same folder in two ways.
      if (current === branch) return { path: worktreePath, isMain: index === 0 };
    }
    return null;
  }, Effect.mapError(receiveFailed));

  /**
   * Where the received thread works. A branch that is new here gets a new worktree. A branch
   * that is already here is reused when it has nothing the remote does not have.
   */
  const receivingWorkspace = Effect.fn("ThreadContinuation.receivingWorkspace")(function* (
    input: ThreadReceiveInput,
    project: Project,
    remoteName: string,
  ) {
    const root = project.workspaceRoot;
    const baseRef = `${remoteName}/${input.branch}`;
    const fetched = yield* git
      .fetchWorktreeBaseCommit({ cwd: root, refName: baseRef })
      .pipe(Effect.mapError(receiveFailed));
    if (fetched === null) {
      return yield* new ThreadContinuationError({
        reason: "receive_failed",
        message: `Branch ${input.branch} is not on ${remoteName}.`,
      });
    }
    // A branch started from the remote-tracking ref tracks it, so the thread can move on again
    // without a push. Starting from origin would start it from the fetched commit instead.
    const newWorktree: ThreadLaunch.ThreadLaunchWorkspaceStrategy = {
      type: "worktree",
      baseRef,
      branch: input.branch,
      startFromOrigin: false,
    };
    const localBranches = yield* git
      .listLocalBranchNames(root)
      .pipe(Effect.mapError(receiveFailed));
    if (!localBranches.includes(input.branch)) return newWorktree;

    const checkout = yield* branchCheckout(root, input.branch);
    if (checkout !== null) {
      // The refresh keeps a dirty checkout that is already on the remote commit, so check first.
      const status = yield* gitWorkflow
        .localStatus({ cwd: checkout.path })
        .pipe(Effect.mapError(receiveFailed));
      const refreshed = status.hasWorkingTreeChanges
        ? null
        : yield* git
            .refreshCheckedOutBranch({ cwd: checkout.path, targetCommit: fetched.commitSha })
            .pipe(Effect.mapError(receiveFailed));
      if (refreshed === null || !refreshed.onTarget) {
        return yield* new ThreadContinuationError({
          reason: "branch_conflict",
          message: `Branch ${input.branch} is checked out at ${checkout.path} with changes or commits that are not on ${remoteName}. Commit and push them, or clean that checkout, then try again.`,
        });
      }
      yield* git
        .setBranchUpstream({
          cwd: checkout.path,
          branch: input.branch,
          remoteName,
          remoteBranch: input.branch,
        })
        .pipe(Effect.mapError(receiveFailed));
      const reused: ThreadLaunch.ThreadLaunchWorkspaceStrategy = checkout.isMain
        ? { type: "root" }
        : { type: "existing_worktree", worktreePath: checkout.path };
      return reused;
    }

    const local = yield* git
      .resolveCommit({ cwd: root, revision: `refs/heads/${input.branch}` })
      .pipe(Effect.mapError(receiveFailed));
    const ancestor = yield* git
      .execute({
        operation: "ThreadContinuation.receive.isAncestor",
        cwd: root,
        args: ["merge-base", "--is-ancestor", local.commitSha, fetched.commitSha],
        allowNonZeroExit: true,
      })
      .pipe(Effect.mapError(receiveFailed));
    if (ancestor.exitCode !== 0) {
      return yield* new ThreadContinuationError({
        reason: "branch_conflict",
        message: `Branch ${input.branch} here has commits that are not on ${remoteName}. Push or remove them, then try again.`,
      });
    }
    yield* git
      .deleteLocalBranch({ cwd: root, refName: input.branch, force: true })
      .pipe(Effect.mapError(receiveFailed));
    return newWorktree;
  });

  /** The thread an earlier try of this send made here, if one did. */
  const alreadyReceived = Effect.fn("ThreadContinuation.alreadyReceived")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(receiveFailed));
    if (shell === null) return null;
    if (shell.deletedAt !== null) {
      return yield* new ThreadContinuationError({
        reason: "receive_failed",
        message: "This thread was received here before, and that thread was deleted.",
      });
    }
    return { threadId: shell.id, projectId: shell.projectId, title: shell.title };
  });

  const receive: ThreadContinuation["Service"]["receive"] = Effect.fn("ThreadContinuation.receive")(
    function* (input) {
      // Every try of one send gets the same ids, so a retry finds the thread the first one made.
      const retryIds =
        input.requestId === undefined
          ? null
          : {
              commandId: CommandId.make(`thread-continuation:${input.requestId}`),
              threadId: ThreadId.make(`thread-continuation:${input.requestId}`),
            };
      const earlier = retryIds === null ? null : yield* alreadyReceived(retryIds.threadId);
      if (earlier !== null) return earlier;
      const canonicalKey = input.repository.canonicalKey;
      const existing = yield* existingProject(canonicalKey);
      // Before any clone, so a send that cannot start here leaves nothing behind.
      const { modelSelection, runtimeMode } = yield* receivingModes(input, existing);
      const project = existing ?? (yield* cloneProject(input));
      const remoteName =
        existing === null ? ORIGIN : yield* remoteForRepository(existing, canonicalKey);
      const workspace = yield* receivingWorkspace(input, project, remoteName);
      if (workspace.type === "worktree") {
        // Launch accepts worktree failures and reports them inside the thread; check first so
        // they come back to the sender and no thread is left behind.
        yield* launches
          .checkWorktreeBase({ projectId: project.id, workspaceStrategy: workspace })
          .pipe(Effect.mapError(receiveFailed));
      }
      const deferWorktree = input.message !== undefined && workspace.type === "worktree";
      const commandId = retryIds?.commandId ?? (yield* newCommandId);
      const launched = yield* launches
        .launch({
          commandId,
          ...(retryIds === null ? {} : { threadId: retryIds.threadId }),
          projectId: project.id,
          title: input.title,
          titleRenamed: true,
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          workspaceStrategy: deferWorktree ? { type: "root" } : workspace,
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
          workspaceStrategy: workspace,
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
