/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Integration eval bridges Effect runtimes with real git worktrees. */
// @effect-diagnostics nodeBuiltinImport:off - temp eval harness uses node git setup helpers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "./config.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "./project/ProjectSetupScriptRunner.ts";
import { SourceControlProviderRegistry } from "./sourceControl/SourceControlProviderRegistry.ts";
import { T3workToolBroker } from "./t3work-toolBroker.ts";
import { TOOL_SPECS } from "./t3work-toolBrokerHelpers.ts";
import { renderAgentsMd } from "./t3work-projectSetupContent.ts";
import { getT3WorkProfile } from "@t3tools/t3work-skill-packs";
import {
  HIDDEN_T3WORK_DIR,
  MANIFEST_FILE_NAME,
  REFERENCES_DIR_NAME,
} from "./t3work-project-repository-utils.ts";
import { T3workThreadToolContextStoreLive } from "./t3work-threadToolContextStore.ts";
import { T3workToolBrokerLive } from "./t3work-toolBrokerLive.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const EVAL_REPO_FULL_NAME = "eval-owner/eval-repo";
const parentThreadId = ThreadId.make("parent-thread-eval");
const projectId = ProjectId.make("project-eval");

type StoredThread = {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
};

const evalRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-start-child-eval-"));
const projectWorkspaceRoot = NodePath.join(evalRoot, "project-workspace");
const linkedRepoPath = NodePath.join(evalRoot, "linked-repo");
let evalHarnessReady = false;

function runGit(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr?.toString() ?? result.status}`,
    );
  }
}

function initLinkedRepo() {
  NodeFS.mkdirSync(projectWorkspaceRoot, { recursive: true });
  NodeFS.mkdirSync(linkedRepoPath, { recursive: true });
  runGit(linkedRepoPath, ["init"]);
  runGit(linkedRepoPath, ["config", "user.email", "eval@test.com"]);
  runGit(linkedRepoPath, ["config", "user.name", "Eval"]);
  NodeFS.writeFileSync(NodePath.join(linkedRepoPath, "README.md"), "# eval repo\n");
  runGit(linkedRepoPath, ["add", "."]);
  runGit(linkedRepoPath, ["commit", "-m", "initial"]);
  runGit(linkedRepoPath, ["branch", "-M", "main"]);

  const manifestDir = NodePath.join(projectWorkspaceRoot, HIDDEN_T3WORK_DIR, REFERENCES_DIR_NAME);
  NodeFS.mkdirSync(manifestDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(manifestDir, MANIFEST_FILE_NAME),
    JSON.stringify({
      linkedRepositories: [
        {
          url: `https://github.com/${EVAL_REPO_FULL_NAME}`,
          localPath: linkedRepoPath,
          status: "cloned",
        },
      ],
    }),
    "utf8",
  );
}

function ensureEvalHarnessReady() {
  if (evalHarnessReady) {
    return;
  }
  initLinkedRepo();
  evalHarnessReady = true;
}

afterAll(() => {
  NodeFS.rmSync(evalRoot, { recursive: true, force: true });
});

function createEvalHarness() {
  ensureEvalHarnessReady();
  const threads = new Map<ThreadId, StoredThread>([
    [
      parentThreadId,
      {
        id: parentThreadId,
        projectId,
        title: "Coordinator thread",
        branch: null,
        worktreePath: null,
      },
    ],
  ]);
  let sequence = 0;

  const orchestrationMock: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        sequence += 1;
        if (
          typeof command === "object" &&
          command !== null &&
          (command as { type?: string }).type === "thread.create"
        ) {
          const create = command as {
            threadId: ThreadId;
            title: string;
            branch?: string | null;
            worktreePath?: string | null;
          };
          threads.set(create.threadId, {
            id: create.threadId,
            projectId,
            title: create.title,
            branch: create.branch ?? null,
            worktreePath: create.worktreePath ?? null,
          });
        }
        return { sequence };
      }),
  };

  const projectionQueryMock: ProjectionSnapshotQueryShape = {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          title: "Eval Project",
          workspaceRoot: projectWorkspaceRoot,
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: (threadId) => {
      const thread = threads.get(threadId);
      if (!thread) {
        return Effect.succeed(Option.none());
      }
      return Effect.succeed(
        Option.some({
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4-mini",
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        }),
      );
    },
  };

  const gitVcsLayer = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-start-child-eval-git-" })),
    Layer.provide(NodeServices.layer),
  );

  const gitWorkflowLayer = Layer.effect(
    GitWorkflowService,
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      return {
        createWorktree: (input) => git.createWorktree(input),
      } as GitWorkflowService["Service"];
    }),
  ).pipe(Layer.provide(gitVcsLayer));

  const brokerLayer = T3workToolBrokerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectionSnapshotQuery, projectionQueryMock),
        Layer.succeed(OrchestrationEngineService, orchestrationMock),
        T3workThreadToolContextStoreLive,
        gitWorkflowLayer,
        gitVcsLayer,
        Layer.succeed(SourceControlProviderRegistry, {
          resolve: () =>
            Effect.succeed({
              getDefaultBranch: () => Effect.succeed("main"),
            }),
        } as unknown as SourceControlProviderRegistry["Service"]),
        Layer.succeed(ProjectSetupScriptRunner, {
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        } as unknown as ProjectSetupScriptRunner["Service"]),
        NodeServices.layer,
      ),
    ),
  );

  const toolContext = {
    surface: "t3work" as const,
    tools: [
      { id: "t3work.thread.start_child", label: "Start child", capabilities: ["write"] as const },
      { id: "t3work.view.read", label: "Read view", capabilities: ["read"] as const },
    ],
    state: {
      view: {
        kind: "thread" as const,
        projectId,
        projectTitle: "Eval Project",
        workspaceRoot: projectWorkspaceRoot,
        threadId: parentThreadId,
        threadTitle: "Coordinator thread",
        ticketId: "EVAL-1",
        displayMode: "embedded" as const,
      },
    },
  };

  return {
    threads,
    runBroker: <A>(program: Effect.Effect<A, never, T3workToolBroker>) =>
      Effect.runPromise(program.pipe(Effect.provide(brokerLayer), Effect.scoped)),
    toolContext,
  };
}

describe("t3work.thread.start_child execution_scope integration eval", () => {
  it("marks execution_scope required in the published tool schema", () => {
    const schema = TOOL_SPECS["t3work.thread.start_child"].inputSchema as {
      required?: ReadonlyArray<string>;
      properties?: Record<string, { enum?: ReadonlyArray<string> }>;
    };
    expect(schema.required).toEqual(["name", "execution_scope"]);
    expect(schema.properties?.execution_scope?.enum).toEqual(["metarepo", "repository"]);
  });

  it("documents vague planning vs implementation handoffs in AGENTS.md", () => {
    const agentsMd = renderAgentsMd(getT3WorkProfile("engineering-copilot"));
    expect(agentsMd).toContain("execution_scope");
    expect(agentsMd).toContain("Planning, triage, synthesis, project status");
    expect(agentsMd).toContain("Implementation, debugging, tests, review, PR work");
    expect(agentsMd).toContain("Do not pass `repo_full_name`");
    expect(agentsMd).toContain("Pass `repo_full_name`");
  });

  it("scenario A: vague planning stays metarepo with no worktree", async () => {
    const harness = createEvalHarness();
    const { startResult, childView } = await harness.runBroker(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        const binding = yield* broker.bindSession({
          threadId: parentThreadId,
          toolContext: harness.toolContext,
        });
        const startResult = yield* binding!.callTool({
          server: "t3work",
          tool: "t3work.thread.start_child",
          arguments: {
            name: "Plan checkout reliability",
            execution_scope: "metarepo",
            kickoff_mode: "plan",
            kickoff_prompt:
              "Review ticket context and outline how we should improve checkout reliability across linked repos.",
          },
        });
        const structured = startResult.structuredContent as { project_session_id: string };
        const childBinding = yield* broker.bindSession({
          threadId: ThreadId.make(structured.project_session_id),
        });
        const childView = yield* childBinding!.callTool({
          server: "t3work",
          tool: "t3work.view.read",
        });
        return { startResult, childView };
      }),
    );

    const structured = startResult.structuredContent as {
      execution_scope: string;
      project_session_id: string;
      worktree_path?: string;
    };
    expect(startResult.isError).toBeUndefined();
    expect(structured.execution_scope).toBe("metarepo");
    expect(structured.worktree_path).toBeUndefined();

    const childThread = harness.threads.get(ThreadId.make(structured.project_session_id));
    expect(childThread?.worktreePath).toBeNull();
    expect(childThread?.branch).toBeNull();

    const view = childView.structuredContent as {
      thread: { executionScope: string; workspace: { worktreePath: string | null } };
    };
    expect(view.thread.executionScope).toBe("metarepo");
    expect(view.thread.workspace.worktreePath).toBeNull();
  });

  it("scenario B: implement-it follow-up creates repository scope with real worktree", async () => {
    const harness = createEvalHarness();
    const { startResult, childView } = await harness.runBroker(
      Effect.gen(function* () {
        const broker = yield* T3workToolBroker;
        const binding = yield* broker.bindSession({
          threadId: parentThreadId,
          toolContext: harness.toolContext,
        });
        const startResult = yield* binding!.callTool({
          server: "t3work",
          tool: "t3work.thread.start_child",
          arguments: {
            name: "Implement checkout fix",
            execution_scope: "repository",
            repo_full_name: EVAL_REPO_FULL_NAME,
            kickoff_prompt: "Implement the planned checkout reliability fix in this repository.",
          },
        });
        const structured = startResult.structuredContent as { project_session_id: string };
        const childBinding = yield* broker.bindSession({
          threadId: ThreadId.make(structured.project_session_id),
        });
        const childView = yield* childBinding!.callTool({
          server: "t3work",
          tool: "t3work.view.read",
        });
        return { startResult, childView };
      }),
    );

    const structured = startResult.structuredContent as {
      execution_scope: string;
      repo_full_name: string;
      project_session_id: string;
      worktree_path: string;
      branch: string;
    };
    expect(startResult.isError).toBeUndefined();
    expect(structured.execution_scope).toBe("repository");
    expect(structured.repo_full_name).toBe(EVAL_REPO_FULL_NAME);
    expect(NodeFS.existsSync(structured.worktree_path)).toBe(true);
    expect(
      NodeChildProcess.spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: structured.worktree_path,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("true");

    const view = childView.structuredContent as {
      thread: {
        executionScope: string;
        workspace: {
          executionScope: string;
          worktreePath: string;
          currentWorkspaceRoot: string;
          branch: string;
        };
      };
    };
    expect(view.thread.executionScope).toBe("repository");
    expect(view.thread.workspace.worktreePath).toBe(structured.worktree_path);
    expect(view.thread.workspace.currentWorkspaceRoot).toBe(structured.worktree_path);
    expect(view.thread.workspace.branch).toBe(structured.branch);
  });

  it("scenario C: ambiguous tool calls fail with clear validation errors", async () => {
    const harness = createEvalHarness();
    const call = (arguments_: Record<string, unknown>) =>
      harness.runBroker(
        Effect.gen(function* () {
          const broker = yield* T3workToolBroker;
          const binding = yield* broker.bindSession({
            threadId: parentThreadId,
            toolContext: harness.toolContext,
          });
          return yield* binding!.callTool({
            server: "t3work",
            tool: "t3work.thread.start_child",
            arguments: arguments_,
          });
        }),
      );

    const missingScope = await call({ name: "Ambiguous child" });
    expect(missingScope.isError).toBe(true);
    expect(missingScope.structuredContent).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("requires 'execution_scope'"),
      }),
    );

    const repositoryWithoutRepo = await call({
      name: "Detached implementation",
      execution_scope: "repository",
    });
    expect(repositoryWithoutRepo.isError).toBe(true);
    expect(repositoryWithoutRepo.structuredContent).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("requires 'repo_full_name'"),
      }),
    );

    const metarepoWithRepo = await call({
      name: "Planning child",
      execution_scope: "metarepo",
      repo_full_name: EVAL_REPO_FULL_NAME,
    });
    expect(metarepoWithRepo.isError).toBe(true);
    expect(metarepoWithRepo.structuredContent).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("must not include 'repo_full_name'"),
      }),
    );
  });
});
