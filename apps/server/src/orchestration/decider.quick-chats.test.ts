import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("quick-chat");
const projectId = ProjectId.make("project");
const create = {
  type: "thread.create",
  commandId: CommandId.make("create"),
  threadId,
  projectId: null,
  title: "Quick chat",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now,
} as const;
const empty: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: now,
};
const createChat = Effect.gen(function* () {
  const events = yield* decideOrchestrationCommand({ command: create, readModel: empty });
  let model = empty;
  for (const event of Array.isArray(events) ? events : [events])
    model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
  return model;
});

it.layer(NodeServices.layer)("quick chats", (it) => {
  it.effect("creates a durable conversation without a project", () =>
    Effect.gen(function* () {
      const model = yield* createChat;
      expect(model.projects).toEqual([]);
      expect(model.threads[0]).toMatchObject({
        id: threadId,
        projectId: null,
        branch: null,
        worktreePath: null,
      });
    }),
  );
  it.effect("rejects repository metadata on unattached chats", () =>
    Effect.gen(function* () {
      const model = yield* createChat;
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("branch"),
            threadId,
            branch: "main",
          },
          readModel: model,
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("rejects pull request links on unattached chats", () =>
    Effect.gen(function* () {
      const model = yield* createChat;
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "thread.pull-request.link",
            commandId: CommandId.make("link"),
            threadId,
            host: "github.com",
            repository: "org/repo",
            number: 1,
            url: "https://github.com/org/repo/pull/1",
            source: "manual",
          },
          readModel: model,
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("attaches an idle chat to a project and preserves its identity", () =>
    Effect.gen(function* () {
      let model = yield* createChat;
      const projects = yield* decideOrchestrationCommand({
        readModel: model,
        command: {
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          createdAt: now,
        },
      });
      for (const event of Array.isArray(projects) ? projects : [projects])
        model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
      const history = [
        {
          id: MessageId.make("question"),
          role: "user" as const,
          text: "Explain passkeys",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ];
      model = {
        ...model,
        threads: model.threads.map((thread) => ({ ...thread, messages: history })),
      };
      const events = yield* decideOrchestrationCommand({
        readModel: model,
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("attach"),
          threadId,
          projectId,
          branch: "feature",
          worktreePath: "/tmp/worktree",
        },
      });
      for (const event of Array.isArray(events) ? events : [events])
        model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
      expect(model.threads[0]).toMatchObject({
        id: threadId,
        projectId,
        title: "Quick chat",
        branch: "feature",
        worktreePath: "/tmp/worktree",
      });
      expect(model.threads[0]?.messages).toEqual(history);
      const repeated = yield* Effect.result(
        decideOrchestrationCommand({
          readModel: model,
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("move-again"),
            threadId,
            projectId,
          },
        }),
      );
      expect(repeated._tag).toBe("Failure");
    }),
  );
  it.effect("rejects attachment while a session is starting", () =>
    Effect.gen(function* () {
      const model = yield* createChat;
      const thread = model.threads[0]!;
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          readModel: {
            ...model,
            threads: [
              {
                ...thread,
                session: {
                  threadId,
                  status: "starting",
                  providerName: "codex",
                  runtimeMode: "approval-required",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: now,
                },
              },
            ],
          },
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("attach-busy"),
            threadId,
            projectId,
          },
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
  for (const deleted of ["project", "thread"] as const) {
    it.effect(`rejects attachment involving a deleted ${deleted}`, () =>
      Effect.gen(function* () {
        let model = yield* createChat;
        for (const command of [
          {
            type: "project.create",
            commandId: CommandId.make("create-project"),
            projectId,
            title: "Project",
            workspaceRoot: "/tmp/project",
            createdAt: now,
          },
          deleted === "project"
            ? {
                type: "project.delete" as const,
                commandId: CommandId.make("delete-project"),
                projectId,
              }
            : {
                type: "thread.delete" as const,
                commandId: CommandId.make("delete-thread"),
                threadId,
              },
        ] as const) {
          const events = yield* decideOrchestrationCommand({ readModel: model, command });
          for (const event of Array.isArray(events) ? events : [events])
            model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
        }
        const result = yield* Effect.result(
          decideOrchestrationCommand({
            readModel: model,
            command: {
              type: "thread.meta.update",
              commandId: CommandId.make("attach-deleted"),
              threadId,
              projectId,
            },
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(String(result.failure)).toContain(
            deleted === "project" ? "deleted project" : "idle, unarchived quick chat",
          );
      }),
    );
  }
  it.effect("rejects attachment while a turn is queued", () =>
    Effect.gen(function* () {
      const model = yield* createChat;
      const queuedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          readModel: {
            ...model,
            threads: model.threads.map((thread) => ({
              ...thread,
              messages: [
                {
                  id: MessageId.make("queued"),
                  role: "user",
                  text: "Continue",
                  turnId: null,
                  streaming: false,
                  createdAt: queuedAt,
                  updatedAt: queuedAt,
                },
              ],
            })),
          },
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("attach-queued"),
            threadId,
            projectId,
          },
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(String(result.failure)).toContain("idle, unarchived quick chat");
    }),
  );
});
