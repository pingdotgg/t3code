// @effect-diagnostics globalDate:off - fixtures use stable timestamps.
// @effect-diagnostics nodeBuiltinImport:off - the portfolio test owns temporary repositories.
// @effect-diagnostics preferSchemaOverJson:off - fixtures persist small scheduler documents.
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Exercises the public scoped scheduler layer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  type AgentDashboardAutomationRun,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentDashboardReviewJobService from "./AgentDashboardReviewJobService.ts";
import * as AgentDashboardReviewScheduler from "./AgentDashboardReviewScheduler.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";

const PROJECT_ID = ProjectId.make("portfolio-scheduler-project");

const initializeGitRepository = async (path: string): Promise<void> => {
  await NodeFSP.mkdir(path, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q", path]);
  await NodeFSP.writeFile(NodePath.join(path, "README.md"), "portfolio scheduler fixture\n");
  NodeChildProcess.execFileSync("git", ["-C", path, "add", "README.md"]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.name=T3 Tests",
    "-c",
    "user.email=t3-tests@example.invalid",
    "commit",
    "-qm",
    "initial",
  ]);
};

const makeProject = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Portfolio scheduler fixture",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

const makeProjection = (project: OrchestrationProjectShell) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getUserInputActivity: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [project],
        threads: [],
        updatedAt: "2026-08-10T00:00:00.000Z",
      }),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 0 }),
    getRecentActivitySummaries: () => Effect.succeed([]),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getImportedAgentSessionSources: () => Effect.succeed([]),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadRuntimeContext: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
    getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
    getTurnStartMessage: () => Effect.succeed(Option.none()),
  });

const completedReviewRun = (): AgentDashboardAutomationRun => ({
  id: "portfolio-review-run",
  status: "succeeded",
  trigger: "manual",
  kind: "repository-review",
  repository: { projectId: PROJECT_ID },
  target: "Portfolio scheduler fixture",
  threadId: null,
  jobId: "portfolio-review-job",
  model: null,
  retryCount: 0,
  findingCount: 1,
  costUnits: null,
  error: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  startedAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:01:00.000Z",
  completedAt: "2026-08-10T00:01:00.000Z",
});

describe("AgentDashboardReviewScheduler portfolio collection", () => {
  it.effect("collects every local source before enqueueing the deep review", () =>
    Effect.promise(async () => {
      const baseDir = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-portfolio-scheduler-"),
      );
      const stateDir = NodePath.join(baseDir, "userdata");
      const repositoryPath = NodePath.join(baseDir, "repository");

      try {
        await initializeGitRepository(repositoryPath);
        await NodeFSP.mkdir(NodePath.join(repositoryPath, "src"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(repositoryPath, "src", "config.ts"),
          'export const api_key = "fake-local-test-token";\n',
        );
        await NodeFSP.mkdir(NodePath.join(stateDir, "agent-dashboard"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(stateDir, "agent-dashboard", "research-watchlist.json"),
          JSON.stringify([
            {
              repository: String(PROJECT_ID),
              title: "Evaluate structured configuration validation",
              summary: "Investigate a schema-backed configuration boundary.",
              source: "local test watchlist",
            },
          ]),
        );
        await NodeFSP.writeFile(
          NodePath.join(stateDir, "agent-dashboard", "review-schedule.json"),
          JSON.stringify({
            id: "t3-findings-portfolio",
            enabled: true,
            nextRunAt: "2099-01-01T00:00:00.000Z",
            lastStatus: "idle",
            runCount: 0,
          }),
        );

        const project = makeProject(repositoryPath);
        const run = completedReviewRun();
        const reviewJobs = Layer.succeed(
          AgentDashboardReviewJobService.AgentDashboardReviewJobService,
          {
            listRuns: Effect.succeed([run]),
            enqueueReview: () => Effect.succeed(run),
            retryRun: () => Effect.succeed(run),
          },
        );
        const schedulerLayer = AgentDashboardReviewScheduler.layer.pipe(
          Layer.provide(reviewJobs),
          Layer.provide(makeProjection(project)),
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provideMerge(NodeServices.layer),
        );

        await Effect.runPromise(
          Effect.gen(function* () {
            const scheduler = yield* AgentDashboardReviewScheduler.AgentDashboardReviewScheduler;
            expect((yield* scheduler.runNow)?.status).toBe("succeeded");
            const status = yield* scheduler.getStatus;
            expect(status).toMatchObject({
              lastStatus: "completed",
              lastCoveredTypes: [
                "bug",
                "security",
                "research",
                "improvement",
                "review",
                "operations",
              ],
              lastSuccessfulTypes: [
                "bug",
                "security",
                "research",
                "improvement",
                "review",
                "operations",
              ],
              lastUnavailableCollectorCount: 0,
            });

            const store = AgentDashboardStore.getStore(stateDir);
            const findings = yield* store.readFindings;
            const types = new Set(findings.map((finding) => finding.type));
            expect(types).toEqual(new Set(["security", "research", "improvement", "operations"]));
            expect((yield* store.readCollectorStates).map((state) => state.kind)).toEqual(
              expect.arrayContaining(["research", "engineering", "security"]),
            );
          }).pipe(Effect.scoped, Effect.provide(schedulerLayer)),
        );
      } finally {
        await NodeFSP.rm(baseDir, { recursive: true, force: true });
      }
    }),
  );
});
