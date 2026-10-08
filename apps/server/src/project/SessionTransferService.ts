// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CommandId,
  ProjectId,
  ThreadId,
  SessionTransferError,
  EventId,
  MessageId,
  TurnItemId,
  ChatAttachmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type SessionTransferExportInput,
  type SessionTransferExportResult,
  type SessionTransferImportInput,
  type SessionTransferImportResult,
  type SessionTransferFinishInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ManagedFolders from "./ManagedProjectFolders.ts";
import * as Projects from "./ProjectService.ts";
import {
  createPendingAttachmentId,
  createAttachmentId,
  parseAttachmentFileExtension,
  attachmentFileExtension,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import {
  readTransferArchive,
  writeTransferArchive,
  workspaceFingerprint,
  TransferArchiveFailure,
  type TransferMetadata,
} from "./sessionTransferArchive.ts";

export class SessionTransferService extends Context.Service<
  SessionTransferService,
  {
    readonly export: (
      input: SessionTransferExportInput,
    ) => Effect.Effect<SessionTransferExportResult, SessionTransferError>;
    readonly import: (
      input: SessionTransferImportInput,
    ) => Effect.Effect<SessionTransferImportResult, SessionTransferError>;
    readonly finish: (
      input: SessionTransferFinishInput,
    ) => Effect.Effect<void, SessionTransferError>;
  }
>()("t3/project/SessionTransferService") {}

const failure = (operation: string, detail: string) =>
  new SessionTransferError({ operation, detail });
const io = <A>(operation: string, action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      failure(
        operation,
        cause instanceof TransferArchiveFailure
          ? cause.message
          : "The project transfer could not access its files. No remote files were removed.",
      ),
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sink = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* Projects.ProjectService;
  const folders = yield* ManagedFolders.ManagedProjectFolders;
  const vcs = yield* VcsProcess.VcsProcess;
  const gate = yield* Semaphore.make(1);
  const transfers = new Map<
    string,
    {
      threadId: ThreadId;
      expires: number;
      fingerprint: string;
      gitFingerprint: string;
      finished: boolean;
    }
  >();
  const git = (root: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    vcs
      .run({
        operation: "session-transfer",
        command: "git",
        args,
        cwd: root,
        allowNonZeroExit,
        timeoutMs: 120_000,
        maxOutputBytes: 16 * 1024 * 1024,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError(() =>
          failure(
            "git",
            "The project Git state could not be transferred. Resolve conflicts and ensure Git is installed on both machines.",
          ),
        ),
      );
  const inspect = Effect.fn("SessionTransfer.inspect")(function* (threadId: ThreadId) {
    const projection = yield* threads
      .getThreadProjection(threadId)
      .pipe(Effect.mapError(() => failure("inspect", "The remote thread could not be read.")));
    if (
      projection.runs.some((run) =>
        ["preparing", "starting", "running", "waiting", "queued"].includes(run.status),
      )
    )
      return yield* Effect.fail(
        failure(
          "inspect",
          "Wait for the remote thread to finish its current turn and clear queued messages before bringing it to local.",
        ),
      );
    const project = yield* projects
      .getById(projection.thread.projectId)
      .pipe(Effect.mapError(() => failure("inspect", "The thread project could not be read.")));
    if (Option.isNone(project))
      return yield* Effect.fail(failure("inspect", "The thread project no longer exists."));
    const root = projection.thread.worktreePath ?? project.value.workspaceRoot;
    const hasGit = yield* io("inspect", async () =>
      NodeFSP.lstat(NodePath.join(root, ".git")).then(
        () => true,
        (e) => {
          if (e.code === "ENOENT") return false;
          throw e;
        },
      ),
    );
    let branch: string | null = null;
    let head = "";
    let index = "";
    let tracked = new Set<string>();
    if (hasGit) {
      const top = (yield* git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
      if (NodePath.resolve(top) !== NodePath.resolve(root))
        return yield* Effect.fail(
          failure(
            "inspect",
            "Bring to local requires the thread workspace to be a repository root.",
          ),
        );
      if ((yield* git(root, ["ls-files", "--unmerged"])).stdout)
        return yield* Effect.fail(
          failure("inspect", "Resolve merge conflicts before bringing this thread to local."),
        );
      branch =
        (yield* git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)).stdout.trim() ||
        null;
      head = (yield* git(root, ["rev-parse", "--verify", "HEAD"], true)).stdout.trim();
      index = (yield* git(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]))
        .stdout;
      tracked = new Set((yield* git(root, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean));
    }
    const records = yield* threads
      .getThreadRecords(threadId, ["messages"])
      .pipe(
        Effect.mapError(() => failure("inspect", "The conversation history could not be read.")),
      );
    const metadata: TransferMetadata = {
      version: 1,
      runtimeMode: projection.thread.runtimeMode,
      interactionMode: projection.thread.interactionMode,
      title: projection.thread.title,
      sourceThreadId: threadId,
      branch,
      hasCommit: Boolean(head),
      hasGit,
      messages: records.messages.map((message) => ({
        role: message.role,
        text: message.text,
        createdAt: DateTime.formatIso(message.createdAt),
        attachments: message.attachments,
      })),
    };
    const attachments = new Map<string, string>();
    const attachmentHash = yield* io("inspect", async () => {
      const hash = NodeCrypto.createHash("sha256");
      for (const attachment of metadata.messages.flatMap((message) => message.attachments)) {
        if (attachments.has(attachment.id)) continue;
        const file = resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: attachment.id,
        });
        if (!file)
          throw new TransferArchiveFailure(
            "A conversation attachment is missing. Restore it before transferring the whole thread.",
          );
        attachments.set(attachment.id, file);
        hash.update(attachment.id);
        const handle = await NodeFSP.open(file, "r");
        try {
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            const { bytesRead } = await handle.read(buffer);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
          }
        } finally {
          await handle.close();
        }
      }
      return hash.digest("hex");
    });
    return {
      root,
      metadata,
      tracked,
      index,
      attachments,
      gitFingerprint: NodeCrypto.createHash("sha256")
        .update(head)
        .update(index)
        .update(attachmentHash)
        .digest("hex"),
      projection,
    };
  });
  const exportTransfer = Effect.fn("SessionTransfer.export")(function* (
    input: SessionTransferExportInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, transfer] of transfers) if (transfer.expires < now) transfers.delete(id);
    if (transfers.size >= 20)
      return yield* Effect.fail(
        failure("export", "Too many transfers are pending. Try again later."),
      );
    const source = yield* inspect(input.threadId);
    const attachmentId = createPendingAttachmentId("bin");
    const output = NodePath.join(config.attachmentsDir, `${attachmentId}.bin`);
    const scratch = yield* io("export", () =>
      NodeFSP.mkdtemp(NodePath.join(config.attachmentsDir, "transfer-")),
    );
    const bundlePath = source.metadata.hasCommit ? NodePath.join(scratch, "bundle") : null;
    const indexPath = source.metadata.hasGit ? NodePath.join(scratch, "index") : null;
    const capture = Effect.gen(function* () {
      if (bundlePath) yield* git(source.root, ["bundle", "create", bundlePath, "HEAD"]);
      if (indexPath)
        yield* io("export", () => NodeFSP.writeFile(indexPath, source.index, { mode: 0o600 }));
      const archive = yield* io("export", () =>
        writeTransferArchive({ ...source, output, bundlePath, indexPath }),
      );
      const latest = yield* inspect(input.threadId);
      const fingerprint = yield* io("export", () =>
        workspaceFingerprint(latest.root, latest.metadata, latest.tracked),
      );
      if (fingerprint !== archive.fingerprint || latest.gitFingerprint !== source.gitFingerprint)
        return yield* Effect.fail(
          failure(
            "export",
            "The remote project changed during capture. Try again when it is idle.",
          ),
        );
      const transferId = NodeCrypto.randomUUID();
      transfers.set(transferId, {
        threadId: input.threadId,
        expires: (yield* Clock.currentTimeMillis) + 30 * 60_000,
        fingerprint,
        gitFingerprint: source.gitFingerprint,
        finished: false,
      });
      return { transferId, attachmentId, sizeBytes: archive.sizeBytes };
    }).pipe(
      Effect.onError(() =>
        io("cleanup", () => NodeFSP.rm(output, { force: true })).pipe(Effect.ignore),
      ),
      Effect.ensuring(
        io("cleanup", () => NodeFSP.rm(scratch, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
      ),
    );
    return yield* capture;
  });
  const importTransfer = Effect.fn("SessionTransfer.import")(function* (
    input: SessionTransferImportInput,
  ) {
    if (!input.attachmentId.startsWith("pending-"))
      return yield* Effect.fail(failure("import", "Choose a pending project transfer upload."));
    const archive = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: input.attachmentId,
    });
    if (!archive)
      return yield* Effect.fail(
        failure("import", "The project transfer upload is missing or expired."),
      );
    yield* io("import", () => NodeFSP.mkdir(folders.namedProjectsRoot, { recursive: true }));
    const root = yield* io("import", () =>
      NodeFSP.mkdtemp(NodePath.join(folders.namedProjectsRoot, "from-remote-")),
    );
    const gitData = yield* io("import", () =>
      NodeFSP.mkdtemp(NodePath.join(config.attachmentsDir, "transfer-")),
    );
    let registrationStarted = false;
    const prepare = Effect.gen(function* () {
      const metadata = yield* io("import", () => readTransferArchive({ archive, root, gitData }));
      if (metadata.hasGit) {
        const template = NodePath.join(gitData, "template");
        yield* io("import", () => NodeFSP.mkdir(template));
        yield* git(root, ["init", `--template=${template}`]);
        if (metadata.branch)
          yield* git(root, ["symbolic-ref", "HEAD", `refs/heads/${metadata.branch}`]);
        if (metadata.hasCommit) {
          yield* git(root, ["fetch", "--no-tags", NodePath.join(gitData, "bundle"), "HEAD"]);
          yield* git(root, ["reset", "--mixed", "FETCH_HEAD"]);
        }
        if ((yield* io("import", () => NodeFSP.stat(NodePath.join(gitData, "index")))).size)
          yield* git(root, ["apply", "--cached", "--binary", NodePath.join(gitData, "index")]);
      }
      const contextFile = `.t3-remote-context-${NodeCrypto.randomUUID()}.json`;
      yield* io("import", () =>
        NodeFSP.writeFile(
          NodePath.join(root, contextFile),
          JSON.stringify(
            {
              ...metadata,
              note: "Transferred conversation; native provider state and running processes were not migrated.",
            },
            null,
            2,
          ),
          { mode: 0o600 },
        ),
      );
      if (metadata.hasGit)
        yield* io("import", async () => {
          await NodeFSP.mkdir(NodePath.join(root, ".git", "info"), { recursive: true });
          return NodeFSP.appendFile(
            NodePath.join(root, ".git", "info", "exclude"),
            `\n/${contextFile}\n`,
          );
        });
      const projectId = ProjectId.make(NodeCrypto.randomUUID());
      // Registration may commit before its final projection read fails. Retain the copied files once it starts.
      registrationStarted = true;
      yield* projects
        .create({
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          projectId,
          title: `${metadata.title} (local)`,
          workspaceRoot: root,
          defaultModelSelection: input.modelSelection,
        })
        .pipe(
          Effect.mapError(() => failure("import", "The local project could not be registered.")),
        );
      const local = yield* launch
        .launch({
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          projectId,
          title: metadata.title,
          modelSelection: input.modelSelection,
          runtimeMode: metadata.runtimeMode,
          interactionMode: metadata.interactionMode,
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError(() =>
            failure(
              "import",
              "The files were copied into a new local project, but its thread could not be created. The remote thread was not stopped.",
            ),
          ),
        );
      const importedAttachments = new Map<string, string>();
      const events: Array<OrchestrationV2DomainEvent> = [];
      const now = yield* DateTime.now;
      events.push({
        id: EventId.make(NodeCrypto.randomUUID()),
        type: "thread.metadata-updated",
        threadId: local.threadId,
        occurredAt: now,
        // The existing import origin enables a portable handoff on the first local turn, as with native CLI transcript imports.
        payload: {
          ...local.projection.thread,
          historyOrigin: "v1_import",
          branch: metadata.branch,
          updatedAt: now,
        },
      });
      for (const [index, message] of metadata.messages.entries()) {
        const attachments = [];
        for (const attachment of message.attachments) {
          let id = importedAttachments.get(attachment.id);
          if (!id) {
            const extension =
              parseAttachmentFileExtension(attachment.id) ??
              attachmentFileExtension(attachment.name).slice(1);
            id = createAttachmentId(local.threadId, extension)!;
            const destination = NodePath.join(config.attachmentsDir, `${id}.${extension}`);
            yield* io("import", () =>
              NodeFSP.copyFile(NodePath.join(gitData, "attachments", attachment.id), destination),
            );
            importedAttachments.set(attachment.id, id);
          }
          attachments.push({ ...attachment, id: ChatAttachmentId.make(id) });
        }
        const at = DateTime.makeUnsafe(message.createdAt);
        const messageId = MessageId.make(`${local.threadId}:import:${index}`);
        events.push({
          id: EventId.make(NodeCrypto.randomUUID()),
          type: "message.updated",
          threadId: local.threadId,
          occurredAt: at,
          payload: {
            createdBy: message.role === "user" ? "user" : "agent",
            creationSource: "server",
            id: messageId,
            threadId: local.threadId,
            runId: null,
            nodeId: null,
            role: message.role,
            text: message.text,
            attachments,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        });
        if (message.role !== "system") {
          const common = {
            id: TurnItemId.make(`${local.threadId}:import:${index}`),
            threadId: local.threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: index + 1,
            status: "completed" as const,
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
          };
          const item: OrchestrationV2TurnItem =
            message.role === "user"
              ? {
                  ...common,
                  type: "user_message",
                  createdBy: "user",
                  creationSource: "server",
                  messageId,
                  inputIntent: "turn_start",
                  text: message.text,
                  attachments,
                }
              : {
                  ...common,
                  type: "assistant_message",
                  messageId,
                  text: message.text,
                  streaming: false,
                };
          events.push({
            id: EventId.make(NodeCrypto.randomUUID()),
            type: "turn-item.updated",
            threadId: local.threadId,
            occurredAt: at,
            payload: item,
          });
        }
      }
      yield* sink
        .write({ events })
        .pipe(
          Effect.mapError(() =>
            failure(
              "import",
              "The files are available in a local project, but conversation import failed. The remote thread was not stopped.",
            ),
          ),
        );
      return {
        threadId: local.threadId,
        workspaceRoot: root,
        runtimeMode: metadata.runtimeMode,
        interactionMode: metadata.interactionMode,
        contextPrompt: `This thread and its project files were brought from a remote environment. The full conversation is in this thread's history and ${contextFile}. Use the imported conversation as context. Check the local workspace and report that it is ready; wait for my next instruction before editing files or starting services. Dependencies and dev servers may need local setup. Native provider state and running processes were not migrated.`,
      };
    }).pipe(
      Effect.onError(() =>
        registrationStarted
          ? Effect.void
          : io("cleanup", () => NodeFSP.rm(root, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
      ),
      Effect.ensuring(
        io("cleanup", () => NodeFSP.rm(gitData, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
      ),
    );
    return yield* prepare;
  });
  const finish = Effect.fn("SessionTransfer.finish")(function* (input: SessionTransferFinishInput) {
    const transfer = transfers.get(input.transferId);
    const now = yield* Clock.currentTimeMillis;
    if (!transfer || transfer.threadId !== input.threadId || transfer.expires < now)
      return yield* Effect.fail(
        failure("finish", "The transfer expired. The remote thread was not stopped."),
      );
    if (transfer.finished) return;
    const source = yield* inspect(input.threadId);
    const fingerprint = yield* io("finish", () =>
      workspaceFingerprint(source.root, source.metadata, source.tracked),
    );
    if (fingerprint !== transfer.fingerprint || source.gitFingerprint !== transfer.gitFingerprint)
      return yield* Effect.fail(
        failure(
          "finish",
          "The remote project changed after capture. Your local copy is available, but the remote thread was not stopped. Transfer again to bring over the latest work.",
        ),
      );
    // Detach provider sessions only after the client has prepared the local project/thread.
    for (const session of source.projection.providerSessions)
      yield* threads
        .dispatch({
          type: "provider-session.detach",
          commandId: CommandId.make(`${input.transferId}:detach:${session.id}`),
          threadId: input.threadId,
          providerSessionId: session.id,
          reason: "client-requested",
        })
        .pipe(
          Effect.mapError(() =>
            failure(
              "finish",
              "The local copy is ready, but the remote session could not be stopped.",
            ),
          ),
        );
    for (const link of source.projection.thread.pullRequests ?? [])
      if (link.watch)
        yield* threads
          .dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`${input.transferId}:unwatch:${link.number}`),
            threadId: input.threadId,
            host: link.host,
            repository: link.repository,
            number: link.number,
            watching: false,
          })
          .pipe(
            Effect.mapError(() =>
              failure(
                "finish",
                "The local copy is ready, but a remote pull request watch could not be stopped.",
              ),
            ),
          );
    transfer.finished = true;
  });
  return SessionTransferService.of({
    export: (input) => exportTransfer(input).pipe(gate.withPermit),
    import: (input) => importTransfer(input).pipe(gate.withPermit),
    finish: (input) => finish(input).pipe(gate.withPermit),
  });
});
export const layer = Layer.effect(SessionTransferService, make);
