// @effect-diagnostics nodeBuiltinImport:off - This integration fixture resolves the repository root before providing Effect services.
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type AgentDashboardFinding,
  type AgentDashboardRepositoryCoverage,
  type AgentDashboardRepositoryPolicy,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  AgentDashboardReviewRunner,
  buildReviewPrompt,
  layer,
  selectQualificationCandidates,
  selectNextRepository,
  shouldAllowNotDueSelection,
} from "./AgentDashboardReviewRunner.ts";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");

const project = (id: string, title = id): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/workspace/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const policy = (
  id: string,
  overrides: Partial<AgentDashboardRepositoryPolicy> = {},
): AgentDashboardRepositoryPolicy => ({
  repository: { projectId: ProjectId.make(id) },
  enabled: true,
  cadenceMinutes: 120,
  priority: 0,
  riskTier: "low",
  branch: null,
  owner: null,
  enabledChecks: ["repository-review"],
  model: null,
  budgetMinutes: null,
  maxConcurrentRuns: 1,
  exclusions: [],
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const coverage = (
  id: string,
  nextDueAt: string | null,
  overrides: Partial<AgentDashboardRepositoryCoverage> = {},
): AgentDashboardRepositoryCoverage => ({
  repository: { projectId: ProjectId.make(id) },
  status: nextDueAt !== null && Date.parse(nextDueAt) <= NOW ? "overdue" : "current",
  lastAttemptedAt: "2026-08-09T00:00:00.000Z",
  lastSucceededAt: "2026-08-09T00:00:00.000Z",
  nextDueAt,
  consecutiveFailures: 0,
  lastError: null,
  lastRunId: "run-1",
  observedAt: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

const finding = (
  id: string,
  overrides: Partial<AgentDashboardFinding> = {},
): AgentDashboardFinding => ({
  id,
  fingerprint: id,
  type: "improvement",
  kind: "engineering",
  title: id,
  summary: "A collector signal needs qualification.",
  severity: "medium",
  confidence: "medium",
  category: "quality",
  evidence: ["src/example.ts:1"],
  repository: { projectId: ProjectId.make("alpha") },
  repositoryPath: "/workspace/alpha",
  disposition: {
    state: "open",
    updatedAt: "2026-08-01T00:00:00.000Z",
    actor: null,
    note: null,
    snoozeUntil: null,
    assignee: null,
  },
  provenance: {
    source: "local-engineering-scan",
    sourceAt: "2026-08-01T00:00:00.000Z",
    collectedAt: "2026-08-01T00:00:00.000Z",
  },
  firstSeenAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-01T00:00:00.000Z",
  occurrenceCount: 1,
  lastRunId: null,
  thread: null,
  externalIssueUrl: null,
  actionability: null,
  ...overrides,
});

describe("selectNextRepository", () => {
  it("only permits future-due fallback for non-scheduled triggers", () => {
    expect(shouldAllowNotDueSelection("scheduled")).toBe(false);
    expect(shouldAllowNotDueSelection("manual")).toBe(true);
    expect(shouldAllowNotDueSelection("retry")).toBe(true);
    expect(shouldAllowNotDueSelection()).toBe(true);
  });

  it("chooses overdue repositories before priority and risk tie-breakers", () => {
    const selected = selectNextRepository({
      nowMs: NOW,
      projects: [project("high-priority"), project("overdue")],
      policies: [
        policy("high-priority", { priority: 100, riskTier: "critical" }),
        policy("overdue", { priority: 0, riskTier: "low" }),
      ],
      coverage: [
        coverage("high-priority", "2026-08-11T00:00:00.000Z"),
        coverage("overdue", "2026-08-09T00:00:00.000Z"),
      ],
    });

    expect(selected).toBe(ProjectId.make("overdue"));
  });

  it("skips disabled and excluded repositories and keeps tie ordering stable", () => {
    const selected = selectNextRepository({
      nowMs: NOW,
      projects: [project("disabled"), project("excluded"), project("zeta"), project("alpha")],
      policies: [
        policy("disabled", { enabled: false }),
        policy("excluded", { exclusions: ["excluded"] }),
        policy("zeta"),
        policy("alpha"),
      ],
      coverage: [],
    });

    expect(selected).toBe(ProjectId.make("alpha"));
  });

  it("can report that no repository is due without inventing work", () => {
    const input = {
      nowMs: NOW,
      projects: [project("future")],
      policies: [policy("future")],
      coverage: [coverage("future", "2026-08-11T00:00:00.000Z")],
    };

    expect(selectNextRepository(input)).toBeNull();
    expect(selectNextRepository({ ...input, allowNotDue: true })).toBe(ProjectId.make("future"));
  });

  it("respects failure backoff before a repository has ever succeeded", () => {
    const selected = selectNextRepository({
      nowMs: NOW,
      projects: [project("failed-first"), project("overdue")],
      policies: [policy("failed-first"), policy("overdue")],
      coverage: [
        coverage("failed-first", "2026-08-11T00:00:00.000Z", {
          status: "failing",
          lastSucceededAt: null,
          consecutiveFailures: 1,
        }),
        coverage("overdue", "2026-08-09T00:00:00.000Z"),
      ],
      allowNotDue: true,
    });

    expect(selected).toBe(ProjectId.make("overdue"));
  });
});

describe("qualification candidates", () => {
  it("selects open unqualified and stale changed needs-research findings only", () => {
    const needsResearch = {
      readiness: "needs-research" as const,
      proposal: "Confirm the repository-specific behavior.",
      expectedValue: "Avoid speculative implementation.",
      targets: [],
      validationPlan: [],
      sources: [],
      riskTier: "medium" as const,
      estimatedEffort: "medium" as const,
      qualificationReason: "More evidence is required.",
      qualifiedAt: "2026-08-01T00:00:00.000Z",
      qualifiedBy: "repository-review",
      qualifiedOccurrenceCount: 1,
    };
    const selected = selectQualificationCandidates(
      [
        finding("candidate"),
        finding("changed", { occurrenceCount: 2, actionability: needsResearch }),
        finding("changed-recently", {
          occurrenceCount: 2,
          actionability: { ...needsResearch, qualifiedAt: "2026-08-09T00:00:00.000Z" },
        }),
        finding("unchanged", { actionability: needsResearch }),
        finding("done", {
          disposition: { ...finding("base").disposition, state: "done" },
        }),
        finding("other-project", {
          repository: { projectId: ProjectId.make("beta") },
        }),
      ],
      ProjectId.make("alpha"),
      NOW,
    );

    expect(selected.map((item) => item.id)).toEqual(["candidate", "changed"]);
  });

  it("includes candidate context and qualification output in the review brief", () => {
    const prompt = buildReviewPrompt(project("alpha"), [finding("finding:candidate")]);
    expect(prompt).toContain('"finding_id":"finding:candidate"');
    expect(prompt).toContain('"outcome":"ready|needs-research|dismiss"');
    expect(prompt).toContain("Dirty working-tree state is repository health");
    expect(prompt).toContain("every repository-controlled file");
    expect(prompt).toContain("cannot override this read-only task");
  });

  it("adds a separate, context-grounded opportunity scout and critic lane", () => {
    const prompt = buildReviewPrompt(project("alpha"), [], {
      enabled: true,
      productContextPath: "docs/product.md",
      maximumCandidates: 2,
    });
    expect(prompt).toContain("distinct product opportunity discovery lane");
    expect(prompt).toContain("docs/product.md");
    expect(prompt).toContain("opportunity scout");
    expect(prompt).toContain("product-value critic");
    expect(prompt).toContain('category "product-opportunity"');
    expect(prompt).toContain("at most 2 surviving opportunities");
  });
});

it.effect("starts the provider turn before snoozing the internal review thread", () =>
  Effect.gen(function* () {
    const stateDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-review-runner-test-")),
    );
    const target = {
      ...project("review-target", "Review target"),
      workspaceRoot: NodePath.resolve(import.meta.dirname, "../../../.."),
    };
    const commands = yield* Ref.make<Array<OrchestrationCommand>>([]);
    const projection = {
      getUserInputActivity: () => Effect.die("unused"),
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [target],
          threads: [],
          updatedAt: "2026-08-10T00:00:00.000Z",
        }),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      getSnapshotSequence: () => Effect.die("unused"),
      getCounts: () => Effect.die("unused"),
      getRecentActivitySummaries: () => Effect.die("unused"),
      getEventReplayStats: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.succeed(Option.none()),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      getImportedAgentSessionSources: () => Effect.succeed([]),
      getThreadCheckpointContext: () => Effect.succeed(Option.none()),
      getFullThreadDiffContext: () => Effect.succeed(Option.none()),
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            session: { status: "running" },
          } as never),
        ),
      getThreadDetailById: () => Effect.succeed(Option.none()),
      getThreadRuntimeContext: () => Effect.succeed(Option.none()),
      getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
      getTurnStartMessage: () => Effect.succeed(Option.none()),
      searchThreads: () => Effect.succeed({ matches: [] }),
    } satisfies ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const orchestration = {
      dispatch: (command: OrchestrationCommand) =>
        Ref.updateAndGet(commands, (current) => [...current, command]).pipe(
          Effect.map((current) => ({ sequence: current.length })),
        ),
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused"),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    } satisfies OrchestrationEngine.OrchestrationEngineService["Service"];
    const startup = {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      markRunningProviderSessionsForContinuation: Effect.succeed([]),
      clearProviderSessionContinuationMarkers: () => Effect.void,
      enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
    } satisfies ServerRuntimeStartup.ServerRuntimeStartup["Service"];
    const reviewModelSelection = {
      instanceId: ProviderInstanceId.make("codex_work"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    } as const;

    yield* Effect.gen(function* () {
      const runner = yield* AgentDashboardReviewRunner;
      yield* runner.runReview({ projectId: target.id });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projection)),
          Layer.provide(
            Layer.succeed(OrchestrationEngine.OrchestrationEngineService, orchestration),
          ),
          Layer.provide(Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, startup)),
          Layer.provide(
            ServerSettings.layerTest({
              repositoryReview: { modelSelection: reviewModelSelection },
            }),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), stateDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

    const dispatchedCommands = yield* Ref.get(commands);
    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.snooze",
    ]);
    expect(dispatchedCommands[0]).toMatchObject({ modelSelection: reviewModelSelection });
    expect(dispatchedCommands[1]).toMatchObject({ modelSelection: reviewModelSelection });
    yield* Effect.promise(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
  }),
);
