import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerSettings,
  type ServerProvider,
  ThreadId,
  type GitStartCommitWorkflowInput,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CommitWorkflow from "./CommitWorkflowService.ts";
import * as Runner from "./CommitWorkflowRunner.ts";
import { buildCommitWorkflowPrompt } from "./commitWorkflowPrompt.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

const threadId = ThreadId.make("thread:commit-workflow");
const projectId = ProjectId.make("project:commit-workflow");
const input: GitStartCommitWorkflowInput = {
  commandId: CommandId.make("command:commit-workflow"),
  threadId,
  cwd: "/worktree",
  expectedBranch: "feature",
  scope: { type: "working_tree", filePaths: ["src/new runner.php", "src/binary.dat"] },
  instructions: "Schreibe auf Deutsch; unabhängige Helfer zuerst.",
};
const status: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 33,
  pr: null,
};

const writerId = ProviderInstanceId.make("codex_writer");
const writerProvider: ServerProvider = {
  instanceId: writerId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-03T12:00:00Z",
  availability: "available",
  models: [],
  slashCommands: [],
  skills: [],
};

function harness(
  options: {
    status?: Partial<VcsStatusResult>;
    worktreePath?: string | null;
    missingProject?: boolean;
    planMode?: boolean;
    settings?: Partial<ServerSettings>;
    run?: Runner.CommitWorkflowRunner["Service"]["run"];
  } = {},
) {
  const thread = v2PullRequestThread({
    id: threadId,
    projectId,
    title: "Feature",
    branch: "feature",
    worktreePath: options.worktreePath === undefined ? "/worktree" : options.worktreePath,
    modelSelection: {
      instanceId: ProviderInstanceId.make("custom-provider"),
      model: "custom-model",
    },
    runtimeMode: "approval-required",
    interactionMode: options.planMode ? "plan" : "default",
    pullRequests: [],
    createdAt: "2026-11-03T12:00:00Z",
    updatedAt: "2026-11-03T12:00:00Z",
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    latestUserMessageAt: null,
  });
  const run = vi.fn((request: Runner.CommitWorkflowRunInput) =>
    options.run
      ? options.run(request)
      : Effect.succeed({ summary: "Created logical commits; backup: refs/t3/backup/test" }),
  );
  const gitStatus = vi.fn(() => Effect.succeed({ ...status, ...options.status }));
  const layer = CommitWorkflow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(thread),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              options.missingProject
                ? Option.none()
                : Option.some({
                    projectId,
                    title: "Project",
                    workspaceRoot: "/repo",
                    defaultModelSelection: null,
                    defaultThreadEnvMode: null,
                    autoPull: false,
                    faviconPath: null,
                    projectIcon: null,
                    pinnedAt: null,
                    archivedAt: null,
                    scripts: [],
                    createdAt: "2026-11-03T12:00:00Z",
                    updatedAt: "2026-11-03T12:00:00Z",
                    deletedAt: null,
                  }),
            ),
        }),
        Layer.mock(Runner.CommitWorkflowRunner)({ run }),
        ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("generation-writer")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
            [writerId]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
          },
          textGenerationModelSelection: {
            instanceId: ProviderInstanceId.make("generation-writer"),
            model: "writer-model",
          },
          sourceControlWriterModelSelection: null,
          defaultRuntimeMode: "auto-accept-edits",
          ...options.settings,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([writerProvider]),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({ status: gitStatus }),
        FileSystem.layerNoop({
          realPath: (path) => Effect.succeed(path === "/alias" ? "/worktree" : path),
        }),
      ),
    ),
  );
  return { layer, run, gitStatus };
}

describe("agent commit workflow", () => {
  it.effect("uses the configured Source Control writer and custom writing instructions", () => {
    const selection = {
      instanceId: writerId,
      model: "writer-specific-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const h = harness({
      settings: {
        sourceControlWriterModelSelection: selection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Use German subjects.",
          followChangeRequestTemplates: true,
        },
      },
    });
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      yield* service.start(input);
      const request = h.run.mock.calls[0]![0];
      expect(request.modelSelection).toEqual(selection);
      expect(buildCommitWorkflowPrompt(request.request, request.style)).toContain(
        "Use German subjects.",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("honors project overrides for Source Control model and writing style", () => {
    const selection = { instanceId: writerId, model: "project-writer" };
    const h = harness({
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            sourceControlWriterModelSelection: selection,
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Project-specific subjects.",
              followChangeRequestTemplates: true,
            },
          },
        },
      },
    });
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      yield* service.start(input);
      const request = h.run.mock.calls[0]![0];
      expect(request.modelSelection).toEqual(selection);
      expect(buildCommitWorkflowPrompt(request.request, request.style)).toContain(
        "Project-specific subjects.",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("starts independently of the source thread's Plan mode", () => {
    const h = harness({ planMode: true });
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      yield* service.start(input);
      expect(h.run).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("returns the quick-action result using Source Control settings", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      expect(yield* service.start(input)).toEqual({
        summary: "Created logical commits; backup: refs/t3/backup/test",
      });
      expect(h.run).toHaveBeenCalledTimes(1);
      const request = h.run.mock.calls[0]![0];
      expect(request.request).toEqual(input);
      expect(request.projectId).toBe(projectId);
      expect(request.modelSelection).toMatchObject({
        instanceId: "generation-writer",
        model: "writer-model",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("rebuilds branch history from an explicit base without a hunk or commit limit", () => {
    const h = harness({ status: { hasWorkingTreeChanges: false } });
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      yield* service.start({ ...input, scope: { type: "branch", baseRef: "origin/development" } });
      const text = buildCommitWorkflowPrompt(
        h.run.mock.calls[0]![0].request,
        h.run.mock.calls[0]![0].style,
      );
      expect(text).toContain('merge base with "origin/development"');
      expect(text).not.toContain("Selected paths");
      expect(text).toContain("temporary intermediate versions");
      expect(text).toContain("tree object");
      expect(text).toContain("no fixed commit-count target");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each([
    { options: { status: { hasWorkingTreeChanges: true } }, expected: "uncommitted changes" },
    {
      options: { status: { hasWorkingTreeChanges: false, isDefaultRef: true } },
      expected: "feature branch",
    },
    { options: { status: { refName: null } }, expected: "Switch to a Git branch" },
    { options: { status: { isRepo: false } }, expected: "Switch to a Git branch" },
    { options: { status: { refName: "other-feature" } }, expected: "branch changed" },
    { options: { worktreePath: "/other" }, expected: "checkout changed" },
    { options: { missingProject: true }, expected: "project is unavailable" },
  ])("refuses an invalid target before starting an agent: $expected", ({ options, expected }) => {
    const h = harness(options);
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      const error = yield* service.start({ ...input, scope: { type: "branch" } }).pipe(Effect.flip);
      expect(error.message).toContain(expected);
      expect(h.run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("supports a thread at the project root", () => {
    const h = harness({ worktreePath: null });
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      yield* service.start({ ...input, cwd: "/repo" });
      expect(h.gitStatus).toHaveBeenCalledWith({ cwd: "/repo" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("accepts an alias only when it resolves to the thread's own checkout", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      yield* service.start({ ...input, cwd: "/alias" });
      expect(h.gitStatus).toHaveBeenCalledWith({ cwd: "/worktree" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reuses a completed result without rewriting history twice", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* CommitWorkflow.CommitWorkflowService;
      const first = yield* service.start(input);
      expect(yield* service.start(input)).toEqual(first);
      expect(h.run).toHaveBeenCalledTimes(1);
      expect(h.gitStatus).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("cancels the active quick action and releases its resources", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const h = harness({
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
      });
      yield* Effect.gen(function* () {
        const service = yield* CommitWorkflow.CommitWorkflowService;
        const action = yield* service.start(input).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        expect(yield* service.cancel({ commandId: input.commandId, cwd: "/other" })).toBe(false);
        expect(yield* service.cancel({ commandId: input.commandId, cwd: input.cwd })).toBe(true);
        const error = yield* Fiber.join(action).pipe(Effect.flip);
        expect(error.message).toContain("cancelled");
        yield* Deferred.await(stopped);
        expect(yield* service.cancel({ commandId: input.commandId, cwd: input.cwd })).toBe(false);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("refuses a second action on the same checkout", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const h = harness({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.gen(function* () {
        const service = yield* CommitWorkflow.CommitWorkflowService;
        const action = yield* service.start(input).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const error = yield* service
          .start({ ...input, commandId: CommandId.make("another") })
          .pipe(Effect.flip);
        expect(error.message).toContain("already running");
        yield* service.cancel({ commandId: input.commandId, cwd: input.cwd });
        yield* Fiber.join(action).pipe(Effect.ignore);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});
