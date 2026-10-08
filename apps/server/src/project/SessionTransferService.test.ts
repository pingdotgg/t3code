// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ConversationMessage,
  type Project,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  ChatAttachmentId,
  MessageId,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as DateTime from "effect/DateTime";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "./ProjectService.ts";
import * as Folders from "./ManagedProjectFolders.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as Transfer from "./SessionTransferService.ts";

const threadId = ThreadId.make("source");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
async function fixture() {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-transfer-test-"));
  const repo = NodePath.join(base, "repo");
  const source = NodePath.join(base, "worktree");
  await NodeFSP.mkdir(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await NodeFSP.writeFile(NodePath.join(repo, "a.txt"), "original\n");
  await NodeFSP.writeFile(NodePath.join(repo, "deleted.txt"), "delete me\n");
  await NodeFSP.writeFile(NodePath.join(repo, ".gitignore"), ".env\nnode_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  git(repo, "worktree", "add", "-b", "remote-branch", source);
  await NodeFSP.writeFile(NodePath.join(source, "a.txt"), "staged\n");
  git(source, "add", "a.txt");
  await NodeFSP.writeFile(NodePath.join(source, "a.txt"), "unstaged\n");
  await NodeFSP.rm(NodePath.join(source, "deleted.txt"));
  await NodeFSP.writeFile(NodePath.join(source, "binary.bin"), Buffer.from([0, 255, 1, 128]));
  await NodeFSP.writeFile(NodePath.join(source, ".env"), "LOCAL_CONFIG=value\n");
  await NodeFSP.mkdir(NodePath.join(source, "node_modules"));
  await NodeFSP.writeFile(NodePath.join(source, "node_modules", "skip"), "skip");
  const home = NodePath.join(base, "home");
  const attachments = NodePath.join(home, "userdata", "attachments");
  await NodeFSP.mkdir(attachments, { recursive: true });
  const attachmentId = createAttachmentId(threadId, "txt")!;
  await NodeFSP.writeFile(NodePath.join(attachments, `${attachmentId}.txt`), "note");
  const commands: OrchestrationV2ServerCommand[] = [];
  const events: OrchestrationV2DomainEvent[] = [];
  const runs: Array<OrchestrationV2ThreadProjection["runs"][number]> = [];
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Remote work",
      worktreePath: source,
      runtimeMode: "approval-required",
      interactionMode: "default",
      pullRequests: [],
    },
    runs,
    providerSessions: [{ id: "session" }],
  } as unknown as OrchestrationV2ThreadProjection;
  const project = { id: ProjectId.make("project"), workspaceRoot: repo } as Project;
  const messages = [
    {
      id: MessageId.make("source:user"),
      threadId,
      runId: null,
      nodeId: null,
      createdBy: "user",
      creationSource: "web",
      streaming: false,
      updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
      createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
      attachments: [
        {
          type: "file",
          id: ChatAttachmentId.make(attachmentId),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
        },
      ],
      role: "user",
      text: "Keep the binary file.",
    },
    {
      id: MessageId.make("source:assistant"),
      threadId,
      runId: null,
      nodeId: null,
      createdBy: "agent",
      creationSource: "web",
      streaming: false,
      updatedAt: DateTime.makeUnsafe("2026-10-01T00:01:00Z"),
      createdAt: DateTime.makeUnsafe("2026-10-01T00:01:00Z"),
      attachments: [],
      role: "assistant",
      text: "The changes are ready.",
    },
  ] as OrchestrationV2ConversationMessage[];
  const layer = Transfer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(projection),
          getThreadRecords: () =>
            Effect.succeed({ thread: projection.thread, messages }) as unknown as ReturnType<
              Threads.ThreadManagementService["Service"]["getThreadRecords"]
            >,
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: commands.length, storedEvents: [] });
          },
        }),
        Layer.mock(Sink.EventSinkV2)({
          write: (input) => {
            events.push(...input.events);
            return Effect.succeed([]);
          },
        }),
        Layer.mock(Launch.ThreadLaunchService)({
          launch: () =>
            Effect.succeed({ threadId: ThreadId.make("local"), projection, resumed: false }),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
          create: () => Effect.succeed(project),
        }),
        Layer.mock(Folders.ManagedProjectFolders)({
          namedProjectsRoot: NodePath.join(base, "local-projects"),
        }),
        VcsProcess.layer.pipe(Layer.provide(ProcessRunner.layer)),
      ),
    ),
    Layer.provide(ServerConfig.layerTest(base, home)),
    Layer.provide(NodeServices.layer),
  );
  return {
    base,
    source,
    repo,
    home,
    attachments,
    commands,
    projection,
    runs,
    events,
    attachmentId,
    layer,
    cleanup: () => NodeFSP.rm(base, { recursive: true, force: true }),
  };
}

it.effect(
  "copies a worktree as an independent local repository, preserving staged/unstaged changes, binaries and ignored config",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      try {
        yield* Effect.gen(function* () {
          const service = yield* Transfer.SessionTransferService;
          const exported = yield* service.export({ threadId });
          expect(f.commands).toHaveLength(0);
          const imported = yield* service.import({
            attachmentId: exported.attachmentId,
            modelSelection,
          });
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(imported.workspaceRoot, "a.txt"), "utf8"),
            ),
          ).toBe("unstaged\n");
          expect(git(imported.workspaceRoot, "show", ":a.txt")).toBe("staged\n");
          expect(git(imported.workspaceRoot, "rev-parse", "HEAD")).toBe(
            git(f.source, "rev-parse", "HEAD"),
          );
          expect(git(imported.workspaceRoot, "branch", "--show-current").trim()).toBe(
            "remote-branch",
          );
          expect(
            (yield* Effect.promise(() =>
              NodeFSP.stat(NodePath.join(imported.workspaceRoot, ".git")),
            )).isDirectory(),
          ).toBe(true);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(imported.workspaceRoot, "binary.bin")),
            ),
          ).toEqual(Buffer.from([0, 255, 1, 128]));
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(imported.workspaceRoot, ".env"), "utf8"),
            ),
          ).toContain("LOCAL_CONFIG");
          yield* Effect.promise(() =>
            expect(
              NodeFSP.stat(NodePath.join(imported.workspaceRoot, "deleted.txt")),
            ).rejects.toThrow(),
          );
          yield* Effect.promise(() =>
            expect(
              NodeFSP.stat(NodePath.join(imported.workspaceRoot, "node_modules")),
            ).rejects.toThrow(),
          );
          expect(imported.contextPrompt).toContain("full conversation");
          expect(imported.runtimeMode).toBe("approval-required");
          const transcript = (yield* Effect.promise(() =>
            NodeFSP.readdir(imported.workspaceRoot),
          )).find((name) => name.startsWith(".t3-remote-context-"));
          expect(
            JSON.parse(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(imported.workspaceRoot, transcript!), "utf8"),
              ),
            ).messages,
          ).toHaveLength(2);
          const importedMessages = f.events.filter((event) => event.type === "message.updated");
          expect(importedMessages.map((event) => event.payload.text)).toEqual([
            "Keep the binary file.",
            "The changes are ready.",
          ]);
          expect(importedMessages.every((event) => event.threadId === imported.threadId)).toBe(
            true,
          );
          const copiedAttachment = importedMessages[0]!.payload.attachments[0]!;
          expect(copiedAttachment.id).not.toBe(f.attachmentId);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(f.attachments, `${copiedAttachment.id}.txt`), "utf8"),
            ),
          ).toBe("note");
          expect(f.events[0]).toMatchObject({
            type: "thread.metadata-updated",
            payload: { historyOrigin: "v1_import" },
          });
          yield* service.finish({ threadId, transferId: exported.transferId });
          expect(f.commands).toMatchObject([{ type: "provider-session.detach", threadId }]);
          yield* service.finish({ threadId, transferId: exported.transferId });
          expect(f.commands).toHaveLength(1);
        }).pipe(Effect.provide(f.layer));
      } finally {
        yield* Effect.promise(() => f.cleanup());
      }
    }),
);
it.effect("refuses to stop the remote session if the source changes after capture", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    try {
      yield* Effect.gen(function* () {
        const service = yield* Transfer.SessionTransferService;
        const archive = yield* service.export({ threadId });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(f.source, "a.txt"), "changed later"),
        );
        const error = yield* Effect.flip(
          service.finish({ threadId, transferId: archive.transferId }),
        );
        expect(error.message).toContain("changed after capture");
        expect(f.commands).toHaveLength(0);
      }).pipe(Effect.provide(f.layer));
    } finally {
      yield* Effect.promise(() => f.cleanup());
    }
  }),
);
it.effect("refuses active remote threads before creating an archive", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    f.runs.push({ status: "running" } as (typeof f.projection.runs)[number]);
    try {
      yield* Effect.gen(function* () {
        const service = yield* Transfer.SessionTransferService;
        const error = yield* Effect.flip(service.export({ threadId }));
        expect(error.message).toContain("finish its current turn");
        expect(f.commands).toHaveLength(0);
      }).pipe(Effect.provide(f.layer));
    } finally {
      yield* Effect.promise(() => f.cleanup());
    }
  }),
);

it.effect(
  "moves workspace and conversation attachments between two isolated environment homes before stopping the source",
  () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(fixture);
      const destination = yield* Effect.promise(fixture);
      try {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(source.source, "remote-only.txt"), "from remote"),
        );
        yield* Effect.gen(function* () {
          const remote = yield* Transfer.SessionTransferService;
          const archive = yield* remote.export({ threadId });
          yield* Effect.promise(() =>
            NodeFSP.copyFile(
              NodePath.join(source.attachments, `${archive.attachmentId}.bin`),
              NodePath.join(destination.attachments, `${archive.attachmentId}.bin`),
            ),
          );
          const local = yield* Effect.gen(function* () {
            const importer = yield* Transfer.SessionTransferService;
            return yield* importer.import({ attachmentId: archive.attachmentId, modelSelection });
          }).pipe(Effect.provide(Layer.fresh(destination.layer)));
          expect(local.workspaceRoot.startsWith(destination.base)).toBe(true);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(local.workspaceRoot, "remote-only.txt"), "utf8"),
            ),
          ).toBe("from remote");
          expect(source.commands).toHaveLength(0);
          yield* remote.finish({ threadId, transferId: archive.transferId });
          expect(source.commands).toHaveLength(1);
          expect(destination.commands).toHaveLength(0);
          expect(
            destination.events.filter((event) => event.type === "message.updated"),
          ).toHaveLength(2);
        }).pipe(Effect.provide(source.layer));
      } finally {
        yield* Effect.promise(() => Promise.all([source.cleanup(), destination.cleanup()]));
      }
    }),
);
