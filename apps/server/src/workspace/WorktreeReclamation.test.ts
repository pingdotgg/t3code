// @effect-diagnostics nodeBuiltinImport:off - fixtures build real repositories and measure disk with du, independent of the service under test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationV2ProviderSessionJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type WorktreeReclaimRefusalCode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readLiveProviderSessionCwds } from "../storageCleanup.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { make, regenerableIgnoredPath, type ReclamationState } from "./WorktreeReclamation.ts";

const encodeSession = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

const projectId = ProjectId.make("project-reclaim");
const threadId = ThreadId.make("thread-reclaim");

const TestLayer = Layer.mergeAll(
  GitVcsDriver.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-reclaim-config-" })),
  ),
  ProcessRunner.layer,
  SqlitePersistence.layerMemory,
).pipe(Layer.provideMerge(NodeServices.layer));

/** Fixture commands ignore the developer's git config (signing, hooks, identity). */
function git(cwd: string, ...args: Array<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
}

function allocatedBytes(target: string): number {
  return (
    Number.parseInt(
      NodeChildProcess.execFileSync("du", ["-sk", target], { encoding: "utf8" }),
      10,
    ) * 1024
  );
}

interface Fixture {
  readonly base: string;
  readonly project: string;
  readonly worktreesDir: string;
  readonly worktree: string;
}

/**
 * A project cloned from a local bare remote, with a T3-style linked worktree
 * on `feature` whose commit is pushed and merged into `origin/main`, plus an
 * ignored dependency install.
 */
function makeFixture(): Fixture {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "reclaim-")));
  const remote = NodePath.join(base, "remote.git");
  const project = NodePath.join(base, "project");
  const worktreesDir = NodePath.join(base, "worktrees");
  const worktree = NodePath.join(worktreesDir, "feature");
  git(base, "init", "--bare", "-b", "main", remote);
  git(base, "clone", "-q", remote, project);
  NodeFS.writeFileSync(NodePath.join(project, ".gitignore"), "node_modules/\n.env\n");
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "fixture\n");
  git(project, "add", ".");
  git(project, "commit", "-qm", "initial");
  git(project, "push", "-q", "-u", "origin", "main");
  git(project, "remote", "set-head", "origin", "main");
  NodeFS.mkdirSync(worktreesDir);
  git(project, "worktree", "add", "-q", "-b", "feature", worktree, "main");
  NodeFS.writeFileSync(NodePath.join(worktree, "feature.txt"), "feature\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-qm", "feature");
  git(worktree, "push", "-q", "-u", "origin", "feature");
  git(project, "merge", "-q", "--ff-only", "feature");
  git(project, "push", "-q", "origin", "main");
  const dependency = NodePath.join(worktree, "node_modules", "dependency");
  NodeFS.mkdirSync(dependency, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dependency, "index.js"), Buffer.alloc(512 * 1024, 7));
  return { base, project, worktreesDir, worktree };
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  const at = DateTime.makeUnsafe(Date.parse("2026-01-01T00:00:00.000Z"));
  return {
    id: threadId,
    projectId,
    title: "Finished task",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "agent",
    creationSource: "mcp",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: at,
    latestUserMessageAt: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: at,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

interface Harness {
  state: ReclamationState;
  descendantActive: boolean;
}

const setup = (
  options: {
    readonly worktreesDir?: string;
    /** Replaces the harness session cwds, as production reads them. */
    readonly liveSessionCwds?: Effect.Effect<ReadonlyArray<string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(Effect.sync(makeFixture), (fixture) =>
      Effect.sync(() => NodeFS.rmSync(fixture.base, { recursive: true, force: true })),
    );
    const harness: Harness = {
      state: {
        threads: [shell({ branch: "feature", worktreePath: fixture.worktree })],
        projects: [{ id: projectId, workspaceRoot: fixture.project }],
        liveSessionCwds: [],
        liveTerminalCwds: [],
      },
      descendantActive: false,
    };
    const service = yield* make({
      worktreesDir: options.worktreesDir ?? fixture.worktreesDir,
      readState:
        options.liveSessionCwds === undefined
          ? Effect.sync(() => harness.state)
          : options.liveSessionCwds.pipe(
              Effect.map((liveSessionCwds) => ({ ...harness.state, liveSessionCwds })),
            ),
      hasActiveDescendants: () => Effect.sync(() => harness.descendantActive),
      afterRemove: () => Effect.void,
    });
    const updateThread = (overrides: Partial<OrchestrationV2ThreadShell>) => {
      harness.state = {
        ...harness.state,
        threads: harness.state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, ...overrides } : thread,
        ),
      };
    };
    return { fixture, harness, service, updateThread };
  });

const codes = (refusals: ReadonlyArray<{ readonly code: WorktreeReclaimRefusalCode }>) =>
  refusals.map((refusal) => refusal.code).toSorted();

describe("WorktreeReclamation", () => {
  it.effect("reclaims a clean, merged, idle checkout and keeps its branch", () =>
    Effect.gen(function* () {
      const { fixture, service } = yield* setup();
      const measured = allocatedBytes(fixture.worktree);
      expect(measured).toBeGreaterThanOrEqual(512 * 1024);

      const preview = yield* service.reclaim({ threadId, dryRun: true });
      expect(preview).toMatchObject({ status: "eligible", refusals: [], branch: "feature" });
      expect(preview.allocatedBytesBefore).toBe(measured);
      expect(NodeFS.existsSync(fixture.worktree)).toBe(true);

      const reclaimed = yield* service.reclaim({ threadId });
      expect(reclaimed).toMatchObject({
        status: "reclaimed",
        refusals: [],
        worktreePath: fixture.worktree,
        allocatedBytesBefore: measured,
        allocatedBytesAfter: 0,
      });
      expect(NodeFS.existsSync(fixture.worktree)).toBe(false);
      // The branch survives, so the thread's next turn can recreate the checkout.
      expect(git(fixture.project, "rev-parse", "--verify", "refs/heads/feature").trim()).toBe(
        git(fixture.project, "rev-parse", "origin/feature").trim(),
      );
      expect(git(fixture.project, "worktree", "list", "--porcelain")).not.toContain(
        fixture.worktree,
      );

      expect(yield* service.reclaim({ threadId })).toMatchObject({ status: "already_absent" });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses uncommitted, untracked and non-regenerable ignored files", () =>
    Effect.gen(function* () {
      const { fixture, service } = yield* setup();
      NodeFS.writeFileSync(NodePath.join(fixture.worktree, "feature.txt"), "edited\n");
      NodeFS.writeFileSync(NodePath.join(fixture.worktree, ".env"), "SECRET=1\n");
      const dirty = yield* service.reclaim({ threadId });
      expect(dirty.status).toBe("refused");
      expect(codes(dirty.refusals)).toEqual(["ignored_files", "uncommitted_changes"]);
      expect(dirty.refusals.find((r) => r.code === "ignored_files")?.message).toContain(".env");

      git(fixture.worktree, "checkout", "--", "feature.txt");
      NodeFS.rmSync(NodePath.join(fixture.worktree, ".env"));
      NodeFS.writeFileSync(NodePath.join(fixture.worktree, "notes.txt"), "untracked\n");
      expect(codes((yield* service.reclaim({ threadId })).refusals)).toEqual([
        "uncommitted_changes",
      ]);
      expect(NodeFS.existsSync(NodePath.join(fixture.worktree, "notes.txt"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses unpushed commits and branches that are pushed but unmerged", () =>
    Effect.gen(function* () {
      const { fixture, service, updateThread } = yield* setup();
      NodeFS.writeFileSync(NodePath.join(fixture.worktree, "more.txt"), "more\n");
      git(fixture.worktree, "add", ".");
      git(fixture.worktree, "commit", "-qm", "local only");
      expect(codes((yield* service.reclaim({ threadId })).refusals)).toEqual([
        "unmerged",
        "unpushed",
      ]);

      git(fixture.worktree, "push", "-q", "origin", "feature");
      expect(codes((yield* service.reclaim({ threadId, dryRun: true })).refusals)).toEqual([
        "unmerged",
      ]);

      // A merged pull request for the branch is not proof for this HEAD: its snapshot has no
      // head commit, and this commit was pushed after the earlier merge.
      updateThread({
        pullRequests: [
          {
            host: "github.com",
            repository: "fixture/repo",
            number: 1,
            url: "https://github.com/fixture/repo/pull/1",
            source: "agent",
            linkedAt: "2026-01-01T00:00:00.000Z",
            stack: null,
            snapshot: {
              state: "merged",
              title: "Feature",
              headBranch: "feature",
              baseBranch: "main",
              isDraft: false,
              updatedAt: null,
              syncedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        ],
      });
      const stale = yield* service.reclaim({ threadId });
      expect(stale.status).toBe("refused");
      expect(codes(stale.refusals)).toEqual(["unmerged"]);
      expect(NodeFS.existsSync(fixture.worktree)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses while the thread, a descendant, a session or a terminal is live", () =>
    Effect.gen(function* () {
      const { fixture, harness, service, updateThread } = yield* setup();
      updateThread({ status: "running", activeRunId: RunId.make("run-live") });
      harness.descendantActive = true;
      harness.state = {
        ...harness.state,
        liveSessionCwds: [fixture.worktree],
        liveTerminalCwds: [NodePath.join(fixture.worktree, "node_modules")],
      };
      const result = yield* service.reclaim({ threadId });
      expect(result.status).toBe("refused");
      expect(codes(result.refusals)).toEqual([
        "descendant_active",
        "live_session",
        "live_terminal",
        "thread_active",
      ]);
      expect(NodeFS.existsSync(fixture.worktree)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "reclaims a completed, stopped thread whose released session row still reads ready",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const resident = new Set<string>();
        const sessionManager = ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: () => Effect.die("liveness checks must not count as session activity"),
          isLive: (providerSessionId) => Effect.sync(() => resident.has(providerSessionId)),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          release: () => Effect.void,
          releaseUnlessBusy: () => Effect.succeed(true),
          otherWorkingThreads: () => Effect.succeed([]),
          detach: () => Effect.void,
        });
        const { fixture, service, updateThread } = yield* setup({
          liveSessionCwds: readLiveProviderSessionCwds().pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, sessionManager),
            Effect.orDie,
          ),
        });
        // The real owner after Stop and settle: its latest run completed, and
        // settling detached (unbound) a session whose release left it "ready".
        updateThread({
          status: "completed",
          latestRunId: RunId.make("run-finished"),
          latestRunStartedAt: DateTime.makeUnsafe(Date.parse("2025-12-31T23:00:00.000Z")),
        });
        const providerSessionId = ProviderSessionId.make("provider-session-released");
        const writeSession = (status: "ready" | "starting") =>
          Effect.gen(function* () {
            const at = DateTime.makeUnsafe(Date.parse("2026-01-01T00:00:00.000Z"));
            const payload = yield* encodeSession({
              id: providerSessionId,
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              status,
              cwd: fixture.worktree,
              model: null,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: at,
              updatedAt: at,
              lastError: null,
            });
            yield* sql`
            INSERT OR REPLACE INTO orchestration_v2_projection_provider_sessions (
              provider_session_id, thread_id, provider, driver, provider_instance_id,
              status, model, updated_at, payload_json
            ) VALUES (
              ${providerSessionId}, ${threadId}, 'codex', 'codex', 'codex',
              ${status}, NULL, '2026-01-01T00:00:00.000Z', ${payload}
            )
          `;
          }).pipe(Effect.orDie);
        yield* writeSession("ready");
        expect(yield* service.reclaim({ threadId, dryRun: true })).toMatchObject({
          status: "eligible",
          refusals: [],
        });

        // A session this process still holds keeps the checkout.
        resident.add(providerSessionId);
        expect(codes((yield* service.reclaim({ threadId, dryRun: true })).refusals)).toEqual([
          "live_session",
        ]);
        resident.clear();
        // So does one still bound to a thread, or one that is starting.
        yield* sql`
        INSERT INTO orchestration_v2_projection_provider_session_bindings
        VALUES (${providerSessionId}, ${threadId})
      `;
        expect(codes((yield* service.reclaim({ threadId, dryRun: true })).refusals)).toEqual([
          "live_session",
        ]);
        yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
        yield* writeSession("starting");
        expect(codes((yield* service.reclaim({ threadId, dryRun: true })).refusals)).toEqual([
          "live_session",
        ]);
        yield* writeSession("ready");

        const reclaimed = yield* service.reclaim({ threadId });
        expect(reclaimed).toMatchObject({ status: "reclaimed", refusals: [], branch: "feature" });
        expect(NodeFS.existsSync(fixture.worktree)).toBe(false);
        expect(git(fixture.project, "rev-parse", "--verify", "refs/heads/feature").trim()).toBe(
          git(fixture.project, "rev-parse", "origin/feature").trim(),
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses a checkout shared with another thread", () =>
    Effect.gen(function* () {
      const { fixture, harness, service } = yield* setup();
      const other = ThreadId.make("thread-other");
      harness.state = {
        ...harness.state,
        threads: [
          ...harness.state.threads,
          shell({ id: other, branch: "feature", worktreePath: fixture.worktree, archivedAt: null }),
        ],
      };
      const result = yield* service.reclaim({ threadId });
      expect(codes(result.refusals)).toEqual(["shared_binding"]);
      expect(result.refusals[0]?.message).toContain(other);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses checkouts T3 does not manage and threads without a worktree", () =>
    Effect.gen(function* () {
      const elsewhere = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "x-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(elsewhere, { recursive: true, force: true })),
      );
      const { fixture, service, updateThread } = yield* setup({ worktreesDir: elsewhere });
      expect(codes((yield* service.reclaim({ threadId })).refusals)).toEqual([
        "not_server_managed",
      ]);
      updateThread({ worktreePath: null });
      expect(codes((yield* service.reclaim({ threadId })).refusals)).toEqual(["no_worktree"]);
      expect(NodeFS.existsSync(fixture.worktree)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps a checkout whose thread resumed after the first eligibility pass", () =>
    Effect.gen(function* () {
      const { fixture, harness, service } = yield* setup();
      // The locked recheck is the second read: a turn requested in between is visible there.
      const idle = harness.state;
      let reads = 0;
      const resumed: ReclamationState = {
        ...idle,
        threads: idle.threads.map((thread) => ({
          ...thread,
          status: "running" as const,
          activeRunId: RunId.make("run-resumed"),
          latestRunStartedAt: DateTime.makeUnsafe(Date.parse("2026-01-02T00:00:00.000Z")),
        })),
      };
      Object.defineProperty(harness, "state", {
        get: () => (++reads === 1 ? idle : resumed),
      });

      const result = yield* service.reclaim({ threadId });
      expect(reads).toBe(2);
      expect(result.status).toBe("refused");
      expect(codes(result.refusals)).toEqual(["changed_during_reclaim", "thread_active"]);
      expect(NodeFS.existsSync(fixture.worktree)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("regenerableIgnoredPath", () => {
  it("keeps everything except dependency installs, build output and T3 instructions", () => {
    expect(
      [
        "node_modules/",
        "apps/web/node_modules/",
        ".vite-hooks/_/pre-commit",
        "apps/web/tsconfig.tsbuildinfo",
        ".agents/t3/abc/AGENT.md",
        "packages/shared/dist/",
      ].every(regenerableIgnoredPath),
    ).toBe(true);
    expect([".env", ".t3/", "data/local.sqlite", "node_modules"].some(regenerableIgnoredPath)).toBe(
      false,
    );
  });
});
