// @effect-diagnostics globalDate:off - scheduler fixtures pin ISO timestamps.
// @effect-diagnostics nodeBuiltinImport:off - tests use local repository fixtures.
// @effect-diagnostics preferSchemaOverJson:off - this fixture writes a small persisted schedule document.
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- These tests exercise the scheduler's public Effect layer with temporary filesystem state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import * as AgentDashboardSecurityScheduler from "./AgentDashboardSecurityScheduler.ts";

const initializeGitRepository = async (path: string): Promise<void> => {
  await NodeFSP.mkdir(path, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q", path]);
  await NodeFSP.writeFile(NodePath.join(path, "README.md"), "security scheduler fixture\n");
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
  id: ProjectId.make("security-scheduler-project"),
  title: "Security scheduler fixture",
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

describe("AgentDashboardSecurityScheduler", () => {
  it("recovers an interrupted run and makes it immediately due", () => {
    const recovered = AgentDashboardSecurityScheduler.__testing.normalizeSchedule(
      {
        id: "t3-security-collector",
        enabled: true,
        intervalMinutes: 1,
        nextRunAt: "2026-08-11T00:10:00.000Z",
        lastRunAt: "2026-08-11T00:00:00.000Z",
        lastCompletedAt: null,
        lastStatus: "running",
        lastError: null,
        lastTarget: "one repository",
        heartbeatAt: "2026-08-11T00:00:01.000Z",
        runCount: 4,
      },
      Date.parse("2026-08-11T00:05:00.000Z"),
    );

    expect(recovered).toMatchObject({
      lastStatus: "failed",
      nextRunAt: "2026-08-11T00:05:00.000Z",
      lastError: "T3 restarted before the local security scan completed.",
      intervalMinutes: 120,
      runCount: 4,
    });
  });

  it.effect("runs a security collection and persists canonical findings and health", () =>
    Effect.promise(async () => {
      const baseDir = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-security-scheduler-"),
      );
      const repositoryPath = NodePath.join(baseDir, "repository");
      const securitySchedulePath = NodePath.join(
        baseDir,
        "userdata",
        "agent-dashboard",
        "security-schedule.json",
      );

      try {
        await initializeGitRepository(repositoryPath);
        await NodeFSP.mkdir(NodePath.join(repositoryPath, "src"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(repositoryPath, "src", "config.ts"),
          'export const api_key = "fake-local-test-token";\n',
        );
        await NodeFSP.writeFile(
          NodePath.join(repositoryPath, "package.json"),
          '{"name":"security-scheduler-fixture"}\n',
        );
        await NodeFSP.mkdir(NodePath.dirname(securitySchedulePath), { recursive: true });
        await NodeFSP.writeFile(
          securitySchedulePath,
          JSON.stringify({
            id: "t3-security-collector",
            enabled: true,
            nextRunAt: "2099-01-01T00:00:00.000Z",
            lastStatus: "idle",
            runCount: 0,
          }),
        );

        const project = makeProject(repositoryPath);
        const schedulerLayer = AgentDashboardSecurityScheduler.layer.pipe(
          Layer.provide(makeProjection(project)),
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
        );

        await Effect.runPromise(
          Effect.gen(function* () {
            const scheduler =
              yield* AgentDashboardSecurityScheduler.AgentDashboardSecurityScheduler;
            const status = yield* scheduler.runNow;
            expect(status?.lastStatus).toBe("completed");
            expect(status?.runCount).toBe(1);

            const store = AgentDashboardStore.getStore(NodePath.join(baseDir, "userdata"));
            const findings = yield* store.readFindings;
            const collectorStates = yield* store.readCollectorStates;

            expect(findings.length).toBeGreaterThan(0);
            expect(findings.every((finding) => finding.kind === "security")).toBe(true);
            expect(
              findings.some((finding) => finding.provenance.source === "local-secret-scan"),
            ).toBe(true);
            expect(collectorStates).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  kind: "security",
                  status: "available",
                  source: "local-security-scan",
                }),
              ]),
            );
          }).pipe(Effect.scoped, Effect.provide(schedulerLayer)),
        );
      } finally {
        await NodeFSP.rm(baseDir, { recursive: true, force: true });
      }
    }),
  );
});
