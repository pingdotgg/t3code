/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Legacy async tests intentionally bridge Effect runtimes; tracked cleanup is separate from upstream green gate. */
import { describe, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { type OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectSetupScriptRunner } from "./project/ProjectSetupScriptRunner.ts";
import { SourceControlProviderRegistry } from "./sourceControl/SourceControlProviderRegistry.ts";
import { T3workToolBroker, T3WORK_CURRENT_VIEW_RESOURCE_URI } from "./t3work-toolBroker.ts";
import {
  createThreadToolContext,
  dirnamePosix,
  joinPosix,
  makeBrokerLayer,
  makeBrokerLayerWithOptions,
  threadId,
} from "./t3work-toolBrokerTestUtils.ts";

describe("T3workToolBrokerLive", () => {
  it("lists selected tools and returns the current view payload", async () => {
    const orchestrationMock: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.succeed({ sequence: 1 }),
      streamDomainEvents: Stream.empty,
    };

    const binding = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        return yield* broker.bindSession({
          threadId,
          toolContext: createThreadToolContext({
            tools: [{ id: "t3work.view.read", label: "Read view", capabilities: ["read"] }],
          }),
        });
      }).pipe(Effect.provide(makeBrokerLayer(orchestrationMock))),
    );

    expect(binding?.listServers()).toEqual([
      expect.objectContaining({
        name: "t3work",
        tools: {
          "t3work.view.read": expect.objectContaining({ title: "Read current t3work view" }),
        },
        resources: [
          expect.objectContaining({
            uri: T3WORK_CURRENT_VIEW_RESOURCE_URI,
            name: "Current t3work view",
          }),
        ],
      }),
    ]);

    const result = await Effect.runPromise(
      binding!.callTool({ server: "t3work", tool: "t3work.view.read" }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        project: expect.objectContaining({ id: "project-1" }),
        thread: expect.objectContaining({ id: threadId, title: "Original title" }),
      }),
    );
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        thread: expect.objectContaining({
          executionScope: "metarepo",
          workspace: expect.objectContaining({
            executionScope: "metarepo",
            currentWorkspaceRoot: "/workspace/project-1",
            projectWorkspaceRoot: "/workspace/project-1",
            worktreePath: null,
          }),
        }),
      }),
    );
  });

  it("dispatches thread metadata updates for rename", async () => {
    const dispatch = vi.fn((_command: unknown) => Promise.resolve({ sequence: 7 }));
    const orchestrationMock: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: (command) => Effect.promise(() => dispatch(command)),
      streamDomainEvents: Stream.empty,
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        const binding = yield* broker.bindSession({
          threadId,
          toolContext: createThreadToolContext({
            tools: [
              {
                id: "t3work.thread.rename",
                label: "Rename thread",
                capabilities: ["write"],
              },
            ],
          }),
        });
        return yield* binding!.callTool({
          server: "t3work",
          tool: "t3work.thread.rename",
          arguments: { title: "  Updated title  " },
        });
      }).pipe(Effect.provide(makeBrokerLayer(orchestrationMock))),
    );

    expect(result).toEqual(
      expect.objectContaining({
        structuredContent: {
          ok: true,
          threadId,
          title: "Updated title",
        },
      }),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "thread.meta.update",
        threadId,
        title: "Updated title",
      }),
    );
  });

  it("falls back to the stored thread tool context when no toolContext is passed", async () => {
    const orchestrationMock: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.succeed({ sequence: 1 }),
      streamDomainEvents: Stream.empty,
    };

    const binding = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        yield* broker.bindSession({
          threadId,
          toolContext: createThreadToolContext({
            tools: [{ id: "t3work.view.read", label: "Read view", capabilities: ["read"] }],
          }),
        });
        return yield* broker.bindSession({ threadId });
      }).pipe(Effect.provide(makeBrokerLayer(orchestrationMock))),
    );

    expect(binding?.listServers()).toEqual([
      expect.objectContaining({
        tools: {
          "t3work.view.read": expect.objectContaining({ title: "Read current t3work view" }),
        },
      }),
    ]);
  });

  it("creates and optionally starts a child session with session-style arguments", async () => {
    const dispatch = vi.fn((_command: unknown) => Promise.resolve({ sequence: 11 }));
    const orchestrationMock: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: (command) => Effect.promise(() => dispatch(command)),
      streamDomainEvents: Stream.empty,
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        const binding = yield* broker.bindSession({
          threadId,
          toolContext: createThreadToolContext({
            tools: [
              {
                id: "t3work.thread.start_child",
                label: "Start child session",
                capabilities: ["write"],
              },
            ],
            view: {
              ticketId: "PROJ-123",
              displayMode: "embedded",
            },
          }),
        });

        expect(binding).toBeDefined();

        const result = yield* binding!.callTool({
          server: "t3work",
          tool: "t3work.thread.start_child",
          arguments: {
            name: "Child session",
            execution_scope: "metarepo",
            kickoff_prompt: "Investigate the flaky checkout flow",
            kickoff_mode: "plan",
            model: "gpt-5.4",
            reasoning_effort: "high",
          },
        });

        const childThreadId = ThreadId.make(
          (result.structuredContent as { project_session_id: string }).project_session_id,
        );
        const childBinding = yield* broker.bindSession({ threadId: childThreadId });

        expect(childBinding?.listServers()).toEqual([
          expect.objectContaining({
            tools: {
              "t3work.thread.start_child": expect.objectContaining({
                title: "Start child session",
              }),
            },
          }),
        ]);

        return result;
      }).pipe(Effect.provide(makeBrokerLayer(orchestrationMock))),
    );

    expect(result).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          ok: true,
          project_session_id: expect.any(String),
          name: "Child session",
          execution_scope: "metarepo",
          started: true,
          requested_kickoff_mode: "plan",
          interaction_mode: "plan",
        }),
      }),
    );

    const childThreadId = (result.structuredContent as { project_session_id: string })
      .project_session_id;

    expect(dispatch.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            type: "thread.create",
            threadId: childThreadId,
            projectId: "project-1",
            title: "Child session",
            runtimeMode: "full-access",
            interactionMode: "plan",
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          }),
        ],
        [
          expect.objectContaining({
            type: "thread.activity.append",
            threadId,
            activity: expect.objectContaining({
              kind: "t3work.handoff.started",
              payload: expect.objectContaining({
                parentThreadId: threadId,
                childThreadId,
                ticketId: "PROJ-123",
              }),
            }),
          }),
        ],
        [
          expect.objectContaining({
            type: "thread.activity.append",
            threadId: childThreadId,
            activity: expect.objectContaining({
              kind: "t3work.handoff.created",
              payload: expect.objectContaining({
                parentThreadId: threadId,
                childThreadId,
                ticketId: "PROJ-123",
              }),
            }),
          }),
        ],
        [
          expect.objectContaining({
            type: "thread.turn.start",
            threadId: childThreadId,
            runtimeMode: "full-access",
            interactionMode: "plan",
            message: expect.objectContaining({
              role: "user",
              text: "Investigate the flaky checkout flow",
            }),
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          }),
        ],
      ]),
    );
  });

  it("attaches a child session at the ticket root for non-embedded or retargeted handoffs", async () => {
    const dispatch = vi.fn((_command: unknown) => Promise.resolve({ sequence: 17 }));
    const orchestrationMock: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: (command) => Effect.promise(() => dispatch(command)),
      streamDomainEvents: Stream.empty,
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        const binding = yield* broker.bindSession({
          threadId,
          toolContext: createThreadToolContext({
            tools: [
              {
                id: "t3work.thread.start_child",
                label: "Start child session",
                capabilities: ["write"],
              },
            ],
            view: {
              ticketId: "proj-123",
              displayMode: "thread",
            },
          }),
        });

        return yield* binding!.callTool({
          server: "t3work",
          tool: "t3work.thread.start_child",
          arguments: {
            name: "Sibling ticket session",
            execution_scope: "metarepo",
            ticket_id: "proj-456",
          },
        });
      }).pipe(Effect.provide(makeBrokerLayer(orchestrationMock))),
    );

    expect(result).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          ok: true,
          name: "Sibling ticket session",
          started: false,
        }),
      }),
    );

    const childThreadId = (result.structuredContent as { project_session_id: string })
      .project_session_id;
    const childCreatedActivity = dispatch.mock.calls
      .map((call) => call[0])
      .find(
        (command) =>
          typeof command === "object" &&
          command !== null &&
          (command as { type?: string }).type === "thread.activity.append" &&
          (command as { threadId?: string }).threadId === childThreadId,
      ) as { activity: { payload: Record<string, unknown> } } | undefined;

    expect(childCreatedActivity?.activity.payload).toEqual(
      expect.objectContaining({
        childThreadId,
        childTitle: "Sibling ticket session",
        parentTitle: "Original title",
        ticketId: "proj-456",
      }),
    );
    expect(childCreatedActivity?.activity.payload).not.toHaveProperty("parentThreadId");
  });

  it("creates a child session without optional repo services", async () => {
    const dispatch = vi.fn((_command: unknown) => Promise.resolve({ sequence: 13 }));
    const orchestrationMock: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: (command) => Effect.promise(() => dispatch(command)),
      streamDomainEvents: Stream.empty,
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        const binding = yield* broker.bindSession({
          threadId,
          toolContext: createThreadToolContext({
            tools: [
              {
                id: "t3work.thread.start_child",
                label: "Start child session",
                capabilities: ["write"],
              },
            ],
          }),
        });

        return yield* binding!.callTool({
          server: "t3work",
          tool: "t3work.thread.start_child",
          arguments: {
            name: "Child session",
            execution_scope: "metarepo",
          },
        });
      }).pipe(
        Effect.provide(
          makeBrokerLayerWithOptions(orchestrationMock, { includeStartChildServices: false }),
        ),
      ),
    );

    expect(result).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          ok: true,
          name: "Child session",
          execution_scope: "metarepo",
          started: false,
          interaction_mode: "default",
          setup_script_status: "not-requested",
        }),
      }),
    );

    expect(dispatch.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            type: "thread.create",
            projectId: "project-1",
            title: "Child session",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          }),
        ],
      ]),
    );
  });

  it("creates a repo-scoped child session from a requested linked repository ref", async () => {
    const dispatch = vi.fn((_command: unknown) => Promise.resolve({ sequence: 19 }));
    const exists = vi.fn((candidatePath: string) =>
      Effect.succeed(
        candidatePath === "/workspace/project-1/.t3work/references/reference-repositories.json" ||
          candidatePath === "/linked/pingdotgg/t3code",
      ),
    );
    const readFileString = vi.fn(() =>
      Effect.succeed(
        JSON.stringify({
          linkedRepositories: [
            {
              url: "https://github.com/pingdotgg/t3code",
              localPath: "/linked/pingdotgg/t3code",
              status: "cloned",
            },
          ],
        }),
      ),
    );
    const makeDirectory = vi.fn(() => Effect.void);
    const resolveProvider = vi.fn(() =>
      Effect.succeed({
        getDefaultBranch: () => Effect.succeed("main"),
      }),
    );
    const createWorktree = vi.fn(
      (input: { cwd: string; refName: string; newRefName?: string; path: string | null }) =>
        Effect.succeed({
          worktree: {
            path: input.path ?? "/unexpected",
            refName: "feature/review-repo-child-1a2b3c4d",
          },
        }),
    );
    const runForThread = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
    const orchestrationMock: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: (command) => Effect.promise(() => dispatch(command)),
      streamDomainEvents: Stream.empty,
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        const binding = yield* broker.bindSession({
          threadId,
          toolContext: createThreadToolContext({
            tools: [
              {
                id: "t3work.thread.start_child",
                label: "Start child session",
                capabilities: ["write"],
              },
            ],
          }),
        });

        return yield* binding!.callTool({
          server: "t3work",
          tool: "t3work.thread.start_child",
          arguments: {
            name: "Review repo child",
            execution_scope: "repository",
            repo_full_name: "pingdotgg/t3code",
            repo_ref: "release/7.0",
          },
        });
      }).pipe(
        Effect.provide(
          makeBrokerLayerWithOptions(orchestrationMock, {
            startChildServicesLayer: Layer.mergeAll(
              Layer.succeed(FileSystem.FileSystem, {
                exists,
                readFileString,
                makeDirectory,
              } as unknown as FileSystem.FileSystem),
              Layer.succeed(Path.Path, {
                join: joinPosix,
                dirname: dirnamePosix,
              } as unknown as Path.Path),
              Layer.succeed(SourceControlProviderRegistry, {
                resolve: resolveProvider,
              } as unknown as import("./sourceControl/SourceControlProviderRegistry.ts").SourceControlProviderRegistry["Service"]),
              Layer.succeed(GitWorkflowService, {
                createWorktree,
              } as unknown as import("./git/GitWorkflowService.ts").GitWorkflowService["Service"]),
              Layer.succeed(ProjectSetupScriptRunner, {
                runForThread,
              } as unknown as import("./project/ProjectSetupScriptRunner.ts").ProjectSetupScriptRunner["Service"]),
            ),
          }),
        ),
      ),
    );

    const structured = result.structuredContent as {
      project_session_id: string;
      repo_ref: string;
      branch: string;
      worktree_path: string;
    };
    const expectedWorktreePath = joinPosix(
      "/workspace/project-1",
      ".t3work",
      "child-session-worktrees",
      "pingdotgg-t3code",
      `release-7-0-${structured.project_session_id.slice(0, 8).toLowerCase()}`,
    );

    expect(result).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          ok: true,
          name: "Review repo child",
          execution_scope: "repository",
          started: false,
          repo_full_name: "pingdotgg/t3code",
          repo_ref: "release/7.0",
          branch: "feature/review-repo-child-1a2b3c4d",
          worktree_path: expectedWorktreePath,
          setup_script_status: "no-script",
        }),
      }),
    );

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/linked/pingdotgg/t3code",
        refName: "release/7.0",
        path: expectedWorktreePath,
      }),
    );
    expect(makeDirectory).toHaveBeenCalledWith(
      dirnamePosix(expectedWorktreePath),
      expect.objectContaining({ recursive: true }),
    );
    expect(dispatch.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            type: "thread.create",
            title: "Review repo child",
            branch: "feature/review-repo-child-1a2b3c4d",
            worktreePath: expectedWorktreePath,
          }),
        ],
        [
          expect.objectContaining({
            type: "thread.activity.append",
            activity: expect.objectContaining({
              kind: "t3work.handoff.created",
              payload: expect.objectContaining({
                repoFullName: "pingdotgg/t3code",
                repoRef: "release/7.0",
                branch: "feature/review-repo-child-1a2b3c4d",
                worktreePath: expectedWorktreePath,
              }),
            }),
          }),
        ],
      ]),
    );
  });
});
