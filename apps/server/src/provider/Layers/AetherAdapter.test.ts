import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { ExecuteGitResult, GitStatusDetails } from "../../vcs/GitVcsDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import {
  AetherMirrorRegistrationService,
  AetherSessionGitService,
  deterministicClientMessageId,
  makeAetherAdapter,
  parseAetherResume,
  type AetherAdapterSocketOptions,
  type AetherMirrorRegistration,
  type AetherSessionGit,
  type AetherTurnTiming,
} from "./AetherAdapter.ts";
import {
  AetherApiConflictError,
  AetherApiNotFoundError,
  AetherApiTransportError,
  type AetherRestClient,
} from "./aether/restClient.ts";
import type {
  AetherConversationDelta,
  AetherProject,
  AetherTask,
  AetherTimelineMessage,
} from "./aether/restSchemas.ts";
import { wsAssistantDelta, wsTurnCompleted } from "./aether/eventMapper.fixtures.ts";
import type { AetherWebSocketLike } from "./aether/workspaceSocket.ts";

const instanceId = ProviderInstanceId.make("aether");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: () => Effect.die("digest is unused in AetherAdapter tests"),
});

const cleanStatus: GitStatusDetails = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/demo",
  upstreamRef: "origin/feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
};

const gitResult = (stdout: string): ExecuteGitResult => ({
  exitCode: 0 as ChildProcessSpawner.ExitCode,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

/**
 * Canned git executor: a stable HEAD ("headsha") whose content tree is
 * "treesha", so the mirror engine's fingerprint verify passes ("clean tree
 * at the baseline HEAD") and reset/clean/apply succeed silently.
 */
const fakeGitExecute: AetherSessionGit["execute"] = ({ args }) => {
  const first = args[0];
  const last = args[args.length - 1] ?? "";
  if (first === "rev-parse") {
    return Effect.succeed(gitResult(last.endsWith("^{tree}") ? "treesha" : "headsha"));
  }
  if (first === "write-tree") {
    return Effect.succeed(gitResult("treesha"));
  }
  return Effect.succeed(gitResult(""));
};

const gitWith = (
  status: GitStatusDetails,
  originUrl: string | null = "git@github.com:acme/aether.git",
  ghMergeBase: string | null = null,
): AetherSessionGit => ({
  statusDetails: () => Effect.succeed(status),
  readConfigValue: (_cwd, key) =>
    Effect.succeed(
      key === "remote.origin.url"
        ? originUrl
        : status.branch !== null && key === `branch.${status.branch}.gh-merge-base`
          ? ghMergeBase
          : null,
    ),
  execute: fakeGitExecute,
});

const noopMirrorRegistry: AetherMirrorRegistration = {
  register: () => Effect.void,
  deregister: () => Effect.void,
};

/** Zero-wait turn pacing so tests drive everything from the TestClock. */
const zeroTurnTiming: Partial<AetherTurnTiming> = {
  settlePollMs: 0,
  harvestPollMs: 0,
  harvestMaxAttempts: 3,
  interruptPollMs: 0,
  interruptMaxAttempts: 5,
};

/** Every method defects — override exactly what a test expects to be called. */
const unusedRestClient: AetherRestClient = {
  createTask: () => Effect.die("createTask must not be called"),
  respondToTask: () => Effect.die("respondToTask must not be called"),
  stopTask: () => Effect.die("stopTask must not be called — stop is a pure disconnect"),
  removeFromQueue: () => Effect.die("removeFromQueue must not be called"),
  updateTask: () => Effect.die("updateTask must not be called"),
  getTask: () => Effect.die("getTask must not be called"),
  connectWorkspace: () => Effect.die("connectWorkspace must not be called"),
  getConversationMessages: () => Effect.die("getConversationMessages must not be called"),
  getConversationDelta: () => Effect.die("getConversationDelta must not be called"),
  listProjects: () => Effect.die("listProjects must not be called"),
  getProfile: () => Effect.die("getProfile must not be called"),
};

const project = (overrides?: Partial<AetherProject>): AetherProject => ({
  id: "project-1",
  name: "aether",
  repo_url: "https://github.com/acme/aether",
  default_branch: "main",
  task_defaults: {
    agent_type: "codex",
    model: "gpt-5.6-sol",
    interaction_mode: "default",
    reasoning_effort: null,
  },
  ...overrides,
});

const processingTask: AetherTask = {
  id: "task-1",
  project_id: "project-1",
  name: "Fix the flaky test",
  agent_type: "codex",
  model: "gpt-5.6-sol",
  interaction_mode: "default",
  auto_fix_ci: false,
  auto_fix_pr_comments: false,
  auto_rebase: false,
  latest_sequence: 12,
  status: "processing",
  run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:01:00Z" },
};

/**
 * Conversation page for the startSession ledger rebuild (spec item 10): a
 * resumed session re-derives the turn ledger from these rows, so most tests
 * hand it an empty history.
 */
const messagesPage = (task: AetherTask, messages: ReadonlyArray<AetherTimelineMessage> = []) => ({
  task,
  messages,
  activity: [],
  activeProcessingTurn: null,
  latestSequence: task.latest_sequence,
  oldestSequenceLoaded: messages.length > 0 ? messages[0]!.sequence : null,
  oldestSortTimestampLoaded: messages.length > 0 ? messages[0]!.timestamp : null,
  hasMoreOlder: false,
});

const startInput = (overrides?: {
  readonly resumeCursor?: unknown;
  readonly modelSelection?: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly threadId?: ThreadId;
  readonly cwd?: string;
  readonly managedWorktree?: boolean;
}) => ({
  threadId: overrides?.threadId ?? ThreadId.make("thread-1"),
  cwd: overrides?.cwd ?? "/repo",
  runtimeMode: "full-access" as const,
  ...(overrides?.resumeCursor !== undefined ? { resumeCursor: overrides.resumeCursor } : {}),
  ...(overrides?.modelSelection !== undefined ? { modelSelection: overrides.modelSelection } : {}),
  ...(overrides?.managedWorktree !== undefined
    ? { managedWorktree: overrides.managedWorktree }
    : {}),
});

const withAdapter = <A, E>(
  options: {
    readonly git?: AetherSessionGit;
    readonly restClient?: AetherRestClient | undefined;
    readonly hasRestClient?: boolean;
    readonly socket?: AetherAdapterSocketOptions;
    readonly mirrorRegistry?: AetherMirrorRegistration;
    readonly turnTiming?: Partial<AetherTurnTiming>;
  },
  use: (adapter: ProviderAdapterShape<ProviderAdapterError>) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const adapter = yield* makeAetherAdapter({
      instanceId,
      defaultCwd: "/default-cwd",
      attachmentsDir: "/nonexistent-attachments-dir",
      restClient:
        options.hasRestClient === false ? undefined : (options.restClient ?? unusedRestClient),
      socket: options.socket,
      turnTiming: options.turnTiming ?? zeroTurnTiming,
    }).pipe(
      Effect.provideService(AetherSessionGitService, options.git ?? gitWith(cleanStatus)),
      Effect.provideService(
        AetherMirrorRegistrationService,
        options.mirrorRegistry ?? noopMirrorRegistry,
      ),
    );
    return yield* use(adapter);
  }).pipe(
    Effect.scoped,
    Effect.provideService(Crypto.Crypto, testCrypto),
    Effect.provide(NodeServices.layer),
  );

const expectStartFailure = (options: {
  readonly git?: AetherSessionGit;
  readonly restClient?: AetherRestClient;
  readonly hasRestClient?: boolean;
  readonly resumeCursor?: unknown;
}) =>
  withAdapter(options, (adapter) =>
    Effect.flip(
      adapter.startSession(
        startInput(
          options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : undefined,
        ),
      ),
    ),
  );

describe("parseAetherResume", () => {
  it("parses a current-version cursor including the typed turn ledger", () => {
    expect(
      parseAetherResume({
        schemaVersion: 1,
        taskId: "task-1",
        latestSequence: 12,
        turnLedger: [{ turnId: "aether-turn-u1", messageId: "u1" }],
      }),
    ).toEqual({
      schemaVersion: 1,
      taskId: "task-1",
      latestSequence: 12,
      turnLedger: [{ turnId: "aether-turn-u1", messageId: "u1" }],
    });
  });

  it("drops a malformed turn ledger wholesale but keeps the resume", () => {
    // A partial ledger would misclassify the dropped turns as
    // remote-originated, so one bad entry voids the whole ledger.
    expect(
      parseAetherResume({
        schemaVersion: 1,
        taskId: "task-1",
        latestSequence: 12,
        turnLedger: [{ turnId: "aether-turn-u1", messageId: "u1" }, { turn: 1 }],
      }),
    ).toEqual({
      schemaVersion: 1,
      taskId: "task-1",
      latestSequence: 12,
    });
  });

  it("returns undefined for foreign shapes instead of failing", () => {
    expect(parseAetherResume(undefined)).toBeUndefined();
    expect(parseAetherResume(null)).toBeUndefined();
    expect(parseAetherResume("task-1")).toBeUndefined();
    expect(parseAetherResume({ schemaVersion: 2, taskId: "t", latestSequence: 1 })).toBeUndefined();
    expect(
      parseAetherResume({ schemaVersion: 1, taskId: "  ", latestSequence: 1 }),
    ).toBeUndefined();
    expect(
      parseAetherResume({ schemaVersion: 1, taskId: "t", latestSequence: Number.NaN }),
    ).toBeUndefined();
  });
});

describe("AetherAdapter startSession", () => {
  it.effect("fails loudly when the instance has no API key", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({ hasRestClient: false });
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("AETHER_API_KEY");
    }),
  );

  it.effect("refuses a dirty working tree, naming the remediation", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        git: gitWith({ ...cleanStatus, hasWorkingTreeChanges: true }),
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("Commit or stash");
    }),
  );

  it.effect("refuses a non-repo cwd", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        git: gitWith({ ...cleanStatus, isRepo: false }),
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("not a git repository");
    }),
  );

  it.effect("refuses a detached HEAD", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        git: gitWith({ ...cleanStatus, branch: null }),
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("detached HEAD");
    }),
  );

  it.effect("refuses a branch with no upstream", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        git: gitWith({ ...cleanStatus, hasUpstream: false, upstreamRef: null }),
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("git push -u origin feature/demo");
    }),
  );

  it.effect("refuses an unpushed (ahead) branch", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        git: gitWith({ ...cleanStatus, aheadCount: 2 }),
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("ahead of its upstream by 2");
    }),
  );

  it.effect("refuses a behind branch", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        git: gitWith({ ...cleanStatus, behindCount: 3 }),
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("behind its upstream by 3");
    }),
  );

  it.effect("refuses a cwd without an origin remote", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({ git: gitWith(cleanStatus, null) });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("no 'origin' remote");
    }),
  );

  // T10: a driver-owned per-thread worktree (managedWorktree) is created clean
  // from origin/{base} and only the driver writes to it, so the clean-tree /
  // pushed / in-sync preflight is skipped there.
  it.effect(
    "skips the clean-tree preflight for a managed worktree even when it is dirty and has no upstream",
    () =>
      withAdapter(
        {
          // The worktree's temp branch is dirty (mirror output from a prior
          // turn) and has no upstream (git worktree add -b makes a local-only
          // branch) — both would fail the shared-checkout preflight.
          git: gitWith(
            {
              ...cleanStatus,
              hasWorkingTreeChanges: true,
              hasUpstream: false,
              upstreamRef: null,
              aheadCount: 4,
            },
            "git@github.com:acme/aether.git",
            // createWorktree records the fork base; the driver bases the cloud
            // task on it instead of the local-only worktree branch.
            "main",
          ),
          restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
        },
        (adapter) =>
          Effect.gen(function* () {
            const session = yield* adapter.startSession(
              startInput({ cwd: "/worktrees/thread-1", managedWorktree: true }),
            );
            expect(session.status).toBe("ready");
            expect(session.cwd).toBe("/worktrees/thread-1");
          }),
      ),
  );

  it.effect(
    "fails loudly when a managed worktree has no recorded base branch (gh-merge-base)",
    () =>
      Effect.gen(function* () {
        const error = yield* withAdapter(
          {
            // A managed worktree whose fork base was never recorded. Its branch
            // is local-only, so sending it as base_branch is what 404s cloud
            // startup — better to fail here with a clear message.
            git: gitWith(
              { ...cleanStatus, branch: "t3code/abc123", hasUpstream: false, upstreamRef: null },
              "git@github.com:acme/aether.git",
              null,
            ),
            restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
          },
          (adapter) =>
            Effect.flip(
              adapter.startSession(
                startInput({ cwd: "/worktrees/thread-1", managedWorktree: true }),
              ),
            ),
        );
        expect(error._tag).toBe("ProviderAdapterValidationError");
        expect(error.message).toContain("no recorded base branch");
      }),
  );

  it.effect(
    "still refuses the shared 'Current checkout' with uncommitted changes when not a managed worktree",
    () =>
      Effect.gen(function* () {
        const error = yield* withAdapter(
          {
            git: gitWith({ ...cleanStatus, hasWorkingTreeChanges: true }),
            restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
          },
          (adapter) =>
            Effect.flip(adapter.startSession(startInput({ cwd: "/repo", managedWorktree: false }))),
        );
        expect(error._tag).toBe("ProviderAdapterValidationError");
        expect(error.message).toContain("Commit or stash");
      }),
  );

  it.effect(
    "still refuses a dirty worktree the user already had, since it carries no managed marker",
    () =>
      Effect.gen(function* () {
        const error = yield* withAdapter(
          {
            git: gitWith({ ...cleanStatus, hasWorkingTreeChanges: true }),
            restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
          },
          (adapter) =>
            // A secondary worktree of the user's own looks exactly like a
            // driver-owned one from the path alone, so only the absent marker
            // separates them — and it must keep their work safe.
            Effect.flip(adapter.startSession(startInput({ cwd: "/worktrees/user-branch" }))),
        );
        expect(error._tag).toBe("ProviderAdapterValidationError");
        expect(error.message).toContain("Commit or stash");
      }),
  );

  it.effect("registers the worktree cwd as the mirror target, not the shared checkout", () => {
    const registeredCwds: Array<string> = [];
    return withAdapter(
      {
        git: gitWith(
          { ...cleanStatus, hasUpstream: false, upstreamRef: null },
          "git@github.com:acme/aether.git",
          "main",
        ),
        restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
        mirrorRegistry: {
          register: (cwd) =>
            Effect.sync(() => {
              registeredCwds.push(cwd);
            }),
          deregister: () => Effect.void,
        },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput({ cwd: "/worktrees/thread-1", managedWorktree: true }),
          );
          // The mirror re-baselines and applies diffs against the session
          // cwd; registering the worktree path (never "/repo") is proof the
          // mirror targets the isolated worktree, not the shared checkout.
          expect(session.cwd).toBe("/worktrees/thread-1");
          expect(registeredCwds).toEqual(["/worktrees/thread-1"]);
        }),
    );
  });

  it.effect("matches an ssh local origin against an https project repo_url", () =>
    withAdapter(
      {
        // ssh origin (default in gitWith) vs the project's https repo_url —
        // raw string comparison would miss; the shared normalizer must not.
        restClient: {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
        },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(startInput());
          expect(session.status).toBe("ready");
          expect(session.cwd).toBe("/repo");
          // Model defaults to the project task_defaults composite slug.
          expect(session.model).toBe("codex/gpt-5.6-sol");
          // No task yet — no resume cursor to persist.
          expect(session.resumeCursor).toBeUndefined();
          expect(yield* adapter.hasSession(session.threadId)).toBe(true);
          expect(yield* adapter.listSessions()).toHaveLength(1);
        }),
    ),
  );

  it.effect("fails with the link-repo remediation when no project matches", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        restClient: {
          ...unusedRestClient,
          listProjects: () =>
            Effect.succeed([project({ repo_url: "https://github.com/acme/other" })]),
        },
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("Link or import the repository in Aether");
    }),
  );

  it.effect("lists the candidates when several projects share the repo", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        restClient: {
          ...unusedRestClient,
          listProjects: () =>
            Effect.succeed([project(), project({ id: "project-2", name: "aether-fork" })]),
        },
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("'aether' (project-1)");
      expect(error.message).toContain("'aether-fork' (project-2)");
    }),
  );

  it.effect("uses the explicit model selection over the project defaults", () =>
    withAdapter(
      {
        restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput({ modelSelection: { instanceId, model: "claude-code/claude-opus-5" } }),
          );
          expect(session.model).toBe("claude-code/claude-opus-5");
        }),
    ),
  );

  it.effect("rejects a model selection bound to another instance", () =>
    withAdapter({}, (adapter) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          adapter.startSession(
            startInput({
              modelSelection: {
                instanceId: ProviderInstanceId.make("aether_other"),
                model: "codex/gpt-5.6-sol",
              },
            }),
          ),
        );
        expect(error._tag).toBe("ProviderAdapterValidationError");
        expect(error.message).toContain("aether_other");
      }),
    ),
  );

  it.effect("validates a resume cursor's task and keeps the cursor's sequence", () =>
    Effect.gen(function* () {
      const requestedTaskIds: Array<string> = [];
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: (taskId) =>
              Effect.sync(() => {
                requestedTaskIds.push(taskId);
              }).pipe(Effect.as(processingTask)),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
              }),
            );
            // The CURSOR's sequence is the safe replay point — never
            // fast-forwarded to the task row's fresher latest_sequence.
            expect(session.resumeCursor).toEqual({
              schemaVersion: 1,
              taskId: "task-1",
              latestSequence: 7,
            });
          }),
      );
      expect(requestedTaskIds).toEqual(["task-1"]);
    }),
  );

  it.effect(
    "resumes a managed worktree whose recorded base branch is missing (base_branch is only for new tasks)",
    () =>
      Effect.gen(function* () {
        yield* withAdapter(
          {
            // A managed worktree with NO gh-merge-base — an old thread or a
            // repaired checkout. Resume reattaches to an existing task and never
            // sends base_branch, so the missing base must NOT block startSession.
            git: gitWith(
              { ...cleanStatus, branch: "t3code/abc123", hasUpstream: false, upstreamRef: null },
              "git@github.com:acme/aether.git",
              null,
            ),
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              getTask: () => Effect.succeed(processingTask),
              getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const session = yield* adapter.startSession(
                startInput({
                  cwd: "/worktrees/thread-1",
                  managedWorktree: true,
                  resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
                }),
              );
              expect(session.resumeCursor).toMatchObject({ taskId: "task-1" });
            }),
        );
      }),
  );

  it.effect("fails with session-not-found when the resumed task is gone", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        restClient: {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () =>
            Effect.fail(
              new AetherApiNotFoundError({ endpoint: "GET /tasks/{id}", detail: "task not found" }),
            ),
        },
        resumeCursor: { schemaVersion: 1, taskId: "task-gone", latestSequence: 7 },
      });
      expect(error._tag).toBe("ProviderAdapterSessionNotFoundError");
    }),
  );

  it.effect("rejects a resume cursor whose task belongs to another project", () =>
    Effect.gen(function* () {
      const error = yield* expectStartFailure({
        restClient: {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed({ ...processingTask, project_id: "project-other" }),
        },
        resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
      });
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("project-other");
      expect(error.message).toContain("project-1");
    }),
  );

  it.effect("rebuilds the turn ledger from the conversation page, never the cursor snapshot", () =>
    withAdapter(
      {
        restClient: {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(processingTask),
          getConversationMessages: () =>
            Effect.succeed(
              messagesPage(processingTask, [
                {
                  id: "u1",
                  role: "user",
                  content: "first turn",
                  deliveryStatus: "processed",
                  timestamp: "t1",
                  sequence: 1,
                },
                {
                  id: "a1",
                  role: "assistant",
                  variant: "text",
                  content: "done",
                  timestamp: "t2",
                  sequence: 2,
                },
                {
                  id: "m2",
                  role: "user",
                  content: "answered after the last cursor snapshot",
                  deliveryStatus: "processed",
                  timestamp: "t3",
                  sequence: 3,
                },
              ]),
            ),
        },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput({
              resumeCursor: {
                schemaVersion: 1,
                taskId: "task-1",
                latestSequence: 7,
                // Stale by a turn (a crash before the next cursor snapshot):
                // m2 is missing here but present on the page — trusting this
                // ledger would misclassify the driver's own m2 as a
                // remote-originated turn (spec resolved note 7).
                turnLedger: [{ turnId: "aether-turn-u1", messageId: "u1" }],
              },
            }),
          );
          expect(session.resumeCursor).toEqual({
            schemaVersion: 1,
            taskId: "task-1",
            latestSequence: 7,
            turnLedger: [
              { turnId: "aether-turn-u1", messageId: "u1" },
              { turnId: "aether-turn-m2", messageId: "m2" },
            ],
          });
        }),
    ),
  );

  it.effect("ignores a stale-shaped cursor and starts fresh without a task read", () =>
    withAdapter(
      {
        // getTask stays a defect: reaching it would fail the test.
        restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput({ resumeCursor: { schemaVersion: 99, sessionId: "opencode-shaped" } }),
          );
          expect(session.resumeCursor).toBeUndefined();
        }),
    ),
  );
});

describe("AetherAdapter session lifecycle", () => {
  it.effect("stopSession is a pure disconnect that emits one graceful session.exited", () =>
    withAdapter(
      {
        restClient: {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(processingTask),
          getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
        },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput({ resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 } }),
          );
          const events = yield* adapter.streamEvents.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          // stopTask on the fake defects if touched — the pure-disconnect
          // invariant is asserted structurally.
          yield* adapter.stopSession(session.threadId);
          expect(yield* adapter.hasSession(session.threadId)).toBe(false);
          const collected: ReadonlyArray<ProviderRuntimeEvent> = yield* Fiber.join(events);
          expect(collected).toHaveLength(1);
          const exited = collected[0]!;
          expect(exited.type).toBe("session.exited");
          expect(exited.threadId).toBe(session.threadId);
          if (exited.type === "session.exited") {
            expect(exited.payload.exitKind).toBe("graceful");
            expect(exited.payload.recoverable).toBe(true);
            expect(exited.payload.reason).toContain("keeps running");
          }
        }),
    ),
  );

  it.effect("stopSession fails for an unknown thread", () =>
    withAdapter({}, (adapter) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(adapter.stopSession(ThreadId.make("thread-none")));
        expect(error._tag).toBe("ProviderAdapterSessionNotFoundError");
      }),
    ),
  );

  it.effect("stopAll disconnects every session without touching the remote tasks", () =>
    withAdapter(
      {
        restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
      },
      (adapter) =>
        Effect.gen(function* () {
          yield* adapter.startSession(startInput({ threadId: ThreadId.make("thread-a") }));
          yield* adapter.startSession(startInput({ threadId: ThreadId.make("thread-b") }));
          expect(yield* adapter.listSessions()).toHaveLength(2);
          const events = yield* adapter.streamEvents.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* adapter.stopAll();
          expect(yield* adapter.listSessions()).toHaveLength(0);
          expect(yield* adapter.hasSession(ThreadId.make("thread-a"))).toBe(false);
          // Ingestion clears per-session turn/liveness state from
          // session.exited — bulk teardown must emit one per thread, same as
          // stopSession does.
          const collected: ReadonlyArray<ProviderRuntimeEvent> = yield* Fiber.join(events);
          expect(collected).toHaveLength(2);
          const exitedThreads = collected
            .filter((event) => event.type === "session.exited")
            .map((event) => event.threadId)
            .sort();
          expect(exitedThreads).toEqual([ThreadId.make("thread-a"), ThreadId.make("thread-b")]);
          for (const event of collected) {
            if (event.type === "session.exited") {
              expect(event.payload.exitKind).toBe("graceful");
              expect(event.payload.recoverable).toBe(true);
            }
          }
        }),
    ),
  );

  it.effect("turn methods fail session-not-found for unknown threads; refusals stay loud", () =>
    withAdapter({}, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-1");
        const sendTurn = yield* Effect.flip(adapter.sendTurn({ threadId, input: "hi" }));
        expect(sendTurn._tag).toBe("ProviderAdapterSessionNotFoundError");
        const interrupt = yield* Effect.flip(adapter.interruptTurn(threadId));
        expect(interrupt._tag).toBe("ProviderAdapterSessionNotFoundError");
        // Revert is a deliberate v1 refusal: the mirror is one-way, so the
        // message names the actionable alternative instead of a stub.
        const rollback = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
        expect(rollback._tag).toBe("ProviderAdapterRequestError");
        expect(rollback.message).toContain("one-way mirror");
        expect(rollback.message).toContain("Revert the task from the Aether app");
        // Approvals never exist for Aether — the refusal says what actually
        // happens (auto-approved remotely), not "not implemented".
        const approval = yield* Effect.flip(
          adapter.respondToRequest(threadId, ApprovalRequestId.make("req-1"), "accept"),
        );
        expect(approval._tag).toBe("ProviderAdapterRequestError");
        expect(approval.message).toContain("auto-approve");
      }),
    ),
  );
});

describe("AetherAdapter readThread", () => {
  const timelineFixture: ReadonlyArray<AetherTimelineMessage> = [
    {
      id: "u1",
      role: "user",
      content: "fix the bug",
      deliveryStatus: "delivered",
      timestamp: "t1",
      sequence: 1,
    },
    {
      id: "a1",
      role: "assistant",
      variant: "text",
      content: "looking",
      timestamp: "t2",
      sequence: 2,
    },
    {
      id: "tool1",
      role: "assistant",
      variant: "tool",
      tool: {
        id: "call-1",
        name: "Edit",
        input: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
        status: "completed",
        itemType: "file_change",
        display: { label: "Edit src/app.ts" },
      },
      timestamp: "t3",
      sequence: 3,
    },
    {
      id: "tool2",
      role: "assistant",
      variant: "tool",
      tool: {
        id: "call-2",
        name: "Read",
        input: { file_path: "src/app.ts" },
        status: "completed",
        // file_read is NOT in t3's 7-value union — must classify, never leak.
        itemType: "file_read",
        display: { label: "Read src/app.ts" },
      },
      timestamp: "t4",
      sequence: 4,
    },
    {
      id: "u2",
      role: "user",
      content: "now add a test",
      deliveryStatus: "delivered",
      timestamp: "t5",
      sequence: 5,
    },
    {
      id: "a2",
      role: "assistant",
      variant: "thinking",
      content: "planning",
      isStreaming: false,
      timestamp: "t6",
      sequence: 6,
    },
  ];

  it.effect("returns empty turns for a session with no task yet", () =>
    withAdapter(
      {
        restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(startInput());
          const snapshot = yield* adapter.readThread(session.threadId);
          expect(snapshot).toEqual({ threadId: session.threadId, turns: [] });
        }),
    ),
  );

  it.effect("fails for an unknown thread", () =>
    withAdapter({}, (adapter) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(adapter.readThread(ThreadId.make("thread-none")));
        expect(error._tag).toBe("ProviderAdapterSessionNotFoundError");
      }),
    ),
  );

  it.effect("groups rows into user-opened turns with classified tool items", () =>
    withAdapter(
      {
        restClient: {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(processingTask),
          getConversationMessages: () =>
            Effect.succeed({
              task: processingTask,
              messages: timelineFixture,
              activity: [],
              activeProcessingTurn: null,
              latestSequence: 6,
              oldestSequenceLoaded: 1,
              oldestSortTimestampLoaded: "t1",
              hasMoreOlder: false,
            }),
        },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput({ resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 6 } }),
          );
          const snapshot = yield* adapter.readThread(session.threadId);
          expect(snapshot.turns).toHaveLength(2);
          // Turn ids derive from the durable user-row ids: stable across reads.
          expect(snapshot.turns[0]?.id).toBe("aether-turn-u1");
          expect(snapshot.turns[1]?.id).toBe("aether-turn-u2");
          expect(snapshot.turns[0]?.items).toHaveLength(4);
          expect(snapshot.turns[1]?.items).toHaveLength(2);
          const [, text, editTool, readTool] = snapshot.turns[0]!.items as ReadonlyArray<
            Record<string, unknown>
          >;
          expect(text).toEqual({ type: "assistant_message", id: "a1", content: "looking" });
          expect(editTool).toEqual({
            type: "tool",
            id: "call-1",
            itemType: "file_change",
            name: "Edit",
            status: "completed",
            label: "Edit src/app.ts",
            files: ["src/app.ts"],
          });
          // file_read classifies into the closed union, never a new string.
          expect(readTool).toMatchObject({ type: "tool", itemType: "dynamic_tool_call" });
        }),
    ),
  );

  it.effect("walks hasMoreOlder pages so older turns are never silently dropped", () =>
    Effect.gen(function* () {
      const cursors: Array<unknown> = [];
      // The endpoint serves the NEWEST page first: rows 5-6 arrive on page
      // one, rows 1-4 only behind the older-page cursor.
      const newestRows = timelineFixture.slice(4);
      const olderRows = timelineFixture.slice(0, 4);
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: () => Effect.succeed(processingTask),
            getConversationMessages: (_taskId, before) =>
              Effect.sync(() => {
                cursors.push(before);
              }).pipe(
                Effect.as(
                  before === undefined
                    ? {
                        task: processingTask,
                        messages: newestRows,
                        activity: [],
                        activeProcessingTurn: null,
                        latestSequence: 6,
                        oldestSequenceLoaded: 5,
                        oldestSortTimestampLoaded: "t5",
                        hasMoreOlder: true,
                      }
                    : {
                        task: processingTask,
                        messages: olderRows,
                        activity: [],
                        activeProcessingTurn: null,
                        latestSequence: 6,
                        oldestSequenceLoaded: 1,
                        oldestSortTimestampLoaded: "t1",
                        hasMoreOlder: false,
                      },
                ),
              ),
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 6 },
              }),
            );
            const snapshot = yield* adapter.readThread(session.threadId);
            // Both turns present, oldest first — nothing truncated.
            expect(snapshot.turns).toHaveLength(2);
            expect(snapshot.turns[0]?.id).toBe("aether-turn-u1");
            expect(snapshot.turns[1]?.id).toBe("aether-turn-u2");
          }),
      );
      // TWO full walks: the startSession ledger rebuild and the readThread
      // snapshot each page back to the first turn.
      expect(cursors).toEqual([
        undefined,
        { sequence: 5, sortTimestamp: "t5" },
        undefined,
        { sequence: 5, sortTimestamp: "t5" },
      ]);
    }),
  );

  it.effect("fails loudly when a page claims more older rows without a cursor", () =>
    Effect.gen(function* () {
      // The FIRST fetch (the startSession ledger rebuild) is well-formed;
      // the readThread walk then hits the contract break.
      let calls = 0;
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: () => Effect.succeed(processingTask),
            getConversationMessages: () =>
              Effect.sync(() => {
                calls++;
              }).pipe(
                Effect.map(() => ({
                  task: processingTask,
                  messages: timelineFixture,
                  activity: [],
                  activeProcessingTurn: null,
                  latestSequence: 6,
                  oldestSequenceLoaded: null,
                  oldestSortTimestampLoaded: null,
                  hasMoreOlder: calls > 1,
                })),
              ),
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 6 },
              }),
            );
            const error = yield* Effect.flip(adapter.readThread(session.threadId));
            expect(error._tag).toBe("ProviderAdapterRequestError");
            expect(error.message).toContain("no older-page cursor");
          }),
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// Event pipeline (T4+T5): passive attach + live streaming + reconciliation
// ---------------------------------------------------------------------------

/** Minimal fake WebSocket: opens on listener registration, records sends. */
class FakeAdapterSocket implements AetherWebSocketLike {
  readonly sent: Array<string> = [];
  closed = false;
  private opened = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(type, list);
    if (type === "open" && this.opened) {
      (listener as () => void)();
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.fire("close", { code: 1000, reason: "client closed" });
  }

  open(): void {
    this.opened = true;
    this.fire("open", undefined);
  }

  message(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) });
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const emptyDelta = (task: AetherTask, latestSequence: number): AetherConversationDelta => ({
  task,
  messages: [],
  activity: [],
  activeProcessingTurn: null,
  latestSequence,
  removedMessageIds: [],
  truncated: false,
});

const settleAdapterPump = Effect.gen(function* () {
  for (let i = 0; i < 8; i++) {
    yield* TestClock.adjust("0 millis");
    yield* Effect.yieldNow;
  }
});

const zeroSocketTiming = {
  pollInitialMs: 0,
  pollMaxMs: 0,
  reconnectInitialMs: 0,
  reconnectMaxMs: 0,
  connectDefaultRetryMs: 0,
  requestTimeoutMs: 0,
};

/** A fake socket whose workspace side answers every git diff request. */
const diffAnsweringSocket = (): FakeAdapterSocket => {
  const socket = new FakeAdapterSocket();
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string) => {
    originalSend(data);
    const frame = JSON.parse(data) as { channel?: string; requestId?: string };
    if (frame.channel === "git" && typeof frame.requestId === "string") {
      socket.message({
        channel: "git",
        type: "diff",
        requestId: frame.requestId,
        success: true,
        diff: { baseRef: "headsha", files: [] },
      });
    }
  };
  socket.open();
  return socket;
};

describe("AetherAdapter event pipeline", () => {
  const idleMessageTask: AetherTask = {
    ...processingTask,
    status: "awaiting_input",
    awaiting_input: { kind: "message" },
  };

  const streamingRestClient = (deltaSequences: Array<number>): AetherRestClient => ({
    ...unusedRestClient,
    listProjects: () => Effect.succeed([project()]),
    getTask: () => Effect.succeed(processingTask),
    getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
    connectWorkspace: () =>
      Effect.succeed({
        state: "running",
        transport: { websocket_path: "/workspaces/ws-1/ws", preview_token: "t".repeat(32) },
      } as const),
    getConversationDelta: (_taskId, after) =>
      Effect.sync(() => {
        deltaSequences.push(after);
        // First reconcile: still processing. Later (settle-poll) beats: the
        // turn is over — an idle task, so the backstop emits nothing new.
        return emptyDelta(deltaSequences.length === 1 ? processingTask : idleMessageTask, after);
      }),
  });

  it.effect("attaches passively on resume and streams mapped live events", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeAdapterSocket> = [];
      const deltaSequences: Array<number> = [];
      yield* withAdapter(
        {
          restClient: streamingRestClient(deltaSequences),
          socket: {
            apiBaseUrl: "https://api.runaether.dev",
            apiKey: "aether_test_key",
            // The diff request must resolve, never time out — the workspace
            // side (diffAnsweringSocket) answers it synchronously.
            timing: { ...zeroSocketTiming, requestTimeoutMs: 60_000 },
            webSocketFactory: () => {
              const socket = diffAnsweringSocket();
              sockets.push(socket);
              return socket;
            },
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(7),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
              }),
            );
            yield* settleAdapterPump;

            // Passive attach: subscribed to the agent channel for the task,
            // and the delta reconciliation ran from the CURSOR's sequence.
            expect(sockets).toHaveLength(1);
            expect(sockets[0]!.sent[0]).toBe(
              '{"channel":"agent","type":"subscribe","taskId":"task-1"}',
            );
            expect(deltaSequences).toEqual([7]);

            // Live frames flow through the mapper into streamEvents.
            sockets[0]!.message(wsAssistantDelta);
            sockets[0]!.message(wsTurnCompleted);
            yield* settleAdapterPump;
            yield* adapter.stopSession(session.threadId);
            expect(sockets[0]!.closed).toBe(true);

            const events = yield* Fiber.join(collector);
            expect(events.map((event) => event.type)).toEqual([
              "session.started",
              // The reconcile's status projection: resuming onto a
              // processing task shows the session as running, not idle.
              "session.state.changed",
              // Resume-onto-processing adoption: the first live observation
              // of the in-flight wire turn reconstructs it (spec §2.3).
              "turn.started",
              "content.delta",
              // The settle ran the mirror sync over the LIVE connection —
              // the git diff answered from inside the event pipeline, then
              // the checkpoint went out strictly before the settle.
              "turn.diff.updated",
              "turn.completed",
              "session.exited",
            ]);
            expect(events[1]).toMatchObject({ payload: { state: "running" } });
            expect(events[2]).toMatchObject({
              eventId: "aether:task-1:turn:u1:started",
              turnId: "aether-turn-u1",
            });
            const delta = events[3]!;
            expect(delta).toMatchObject({
              eventId: "aether:task-1:stream:m1:1",
              threadId: session.threadId,
              payload: { streamKind: "assistant_text", delta: "Looking at the" },
            });
            expect(events[4]).toMatchObject({
              eventId: "aether:task-1:turn:u1:diff",
              turnId: "aether-turn-u1",
            });
            // The diff request went out over the git channel.
            expect(sockets[0]!.sent.some((frame) => frame.includes('"channel":"git"'))).toBe(true);
          }),
      );
    }),
  );

  it.effect("emits port.opened with the workspace preview URL, deduping snapshot re-syncs", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeAdapterSocket> = [];
      const deltaSequences: Array<number> = [];
      const TOKEN = "t".repeat(32);
      yield* withAdapter(
        {
          restClient: streamingRestClient(deltaSequences),
          socket: {
            apiBaseUrl: "https://api.runaether.dev",
            apiKey: "aether_test_key",
            timing: { ...zeroSocketTiming, requestTimeoutMs: 60_000 },
            webSocketFactory: () => {
              const socket = diffAnsweringSocket();
              sockets.push(socket);
              return socket;
            },
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.filter((event) => event.type === "port.opened"),
              Stream.take(2),
              Stream.runCollect,
              Effect.forkScoped,
            );
            yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
              }),
            );
            yield* settleAdapterPump;

            // Snapshot surfaces each port once; a re-snapshot dedupes; a
            // distinct open adds exactly one more.
            sockets[0]!.message({ channel: "ports", type: "snapshot", ports: [3000] });
            sockets[0]!.message({ channel: "ports", type: "snapshot", ports: [3000] });
            sockets[0]!.message({ channel: "ports", type: "change", action: "open", port: 5173 });
            yield* settleAdapterPump;

            const events = [...(yield* Fiber.join(collector))];
            expect(events).toHaveLength(2);
            expect(events[0]).toMatchObject({
              type: "port.opened",
              payload: { port: 3000, url: `https://3000-ws-1-${TOKEN}.preview.runaether.dev` },
            });
            expect(events[1]).toMatchObject({
              type: "port.opened",
              payload: { port: 5173, url: `https://5173-ws-1-${TOKEN}.preview.runaether.dev` },
            });
          }),
      );
    }),
  );

  it.effect("resume onto an in-flight task adopts the turn and arms the settle backstop", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeAdapterSocket> = [];
      let deltaCalls = 0;
      let taskIdle = false;
      const restClient: AetherRestClient = {
        ...unusedRestClient,
        listProjects: () => Effect.succeed([project()]),
        getTask: () => Effect.succeed(processingTask),
        getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
        connectWorkspace: () =>
          Effect.succeed({
            state: "running",
            transport: { websocket_path: "/workspaces/ws-1/ws", preview_token: "t".repeat(32) },
          } as const),
        getConversationDelta: (_taskId, after) =>
          Effect.sync(() => {
            deltaCalls++;
            return {
              task: taskIdle ? idleMessageTask : processingTask,
              messages: [],
              activity: [],
              activeProcessingTurn: taskIdle
                ? null
                : { messageId: "m9", startedAt: "2026-08-08T10:02:00Z" },
              latestSequence: after,
              removedMessageIds: [],
              truncated: false,
            } satisfies AetherConversationDelta;
          }),
      };
      yield* withAdapter(
        {
          restClient,
          socket: {
            apiBaseUrl: "https://api.runaether.dev",
            apiKey: "aether_test_key",
            timing: { ...zeroSocketTiming, requestTimeoutMs: 60_000 },
            webSocketFactory: () => {
              const socket = diffAnsweringSocket();
              sockets.push(socket);
              return socket;
            },
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(5),
              Stream.runCollect,
              Effect.forkScoped,
            );
            yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
              }),
            );
            yield* settleAdapterPump;

            // The in-flight wire turn was reconstructed from the delta's
            // activeProcessingTurn: listSessions is in lockstep and Stop has
            // something to grab (spec §2.3) — no sendTurn ever ran.
            const mid = (yield* adapter.listSessions())[0]!;
            expect(mid.status).toBe("running");
            expect(mid.activeTurnId).toBe("aether-turn-m9");

            // The turn settles through the REST backstop poll alone (the
            // socket never delivers a live settle frame).
            taskIdle = true;
            yield* settleAdapterPump;
            const events = yield* Fiber.join(collector);
            expect(events.map((event) => event.type)).toEqual([
              "session.started",
              "turn.started",
              "session.state.changed",
              "turn.diff.updated",
              "turn.completed",
            ]);
            expect(events[1]).toMatchObject({
              eventId: "aether:task-1:turn:m9:started",
              turnId: "aether-turn-m9",
            });
            expect(events[4]).toMatchObject({
              turnId: "aether-turn-m9",
              payload: { state: "completed" },
            });
            // More than the single attach reconcile ran — the poll is armed.
            expect(deltaCalls).toBeGreaterThan(1);

            const after = (yield* adapter.listSessions())[0]!;
            expect(after.status).toBe("ready");
            expect(after.activeTurnId).toBeUndefined();
          }),
      );
    }),
  );

  it.effect(
    "an IDLE session eagerly reconciles a remote turn: warning precedes its live output",
    () =>
      Effect.gen(function* () {
        const sockets: Array<FakeAdapterSocket> = [];
        let deltaCalls = 0;
        const restClient: AetherRestClient = {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(idleMessageTask),
          getConversationMessages: () => Effect.succeed(messagesPage(idleMessageTask)),
          connectWorkspace: () =>
            Effect.succeed({
              state: "running",
              transport: { websocket_path: "/workspaces/ws-1/ws", preview_token: "t".repeat(32) },
            } as const),
          getConversationDelta: (_taskId, after) =>
            Effect.sync(() => {
              deltaCalls++;
              return deltaCalls === 1
                ? emptyDelta(idleMessageTask, after)
                : ({
                    task: processingTask,
                    messages: [
                      {
                        id: "u9",
                        role: "user",
                        content: "driven from the app",
                        deliveryStatus: "processing",
                        timestamp: "t8",
                        sequence: 8,
                      },
                    ],
                    activity: [],
                    activeProcessingTurn: { messageId: "u9", startedAt: "2026-08-08T10:03:00Z" },
                    latestSequence: 8,
                    removedMessageIds: [],
                    truncated: false,
                  } satisfies AetherConversationDelta);
            }),
        };
        yield* withAdapter(
          {
            restClient,
            socket: {
              apiBaseUrl: "https://api.runaether.dev",
              apiKey: "aether_test_key",
              timing: { ...zeroSocketTiming, requestTimeoutMs: 60_000 },
              webSocketFactory: () => {
                const socket = diffAnsweringSocket();
                sockets.push(socket);
                return socket;
              },
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(4),
                Stream.runCollect,
                Effect.forkScoped,
              );
              yield* adapter.startSession(
                startInput({
                  resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
                }),
              );
              yield* settleAdapterPump;
              // The session sits IDLE on a healthy WS: no driver turn is
              // active so the settle poll is not running — the live frame
              // itself must trigger the durable reconcile that carries the
              // remote user row (spec resolved note 9).
              sockets[0]!.message({ ...wsAssistantDelta, turnId: "u9", messageId: "m9" });
              yield* settleAdapterPump;
              const events = yield* Fiber.join(collector);
              expect(events.map((event) => event.type)).toEqual([
                "session.started",
                // Build item 13: the injected prompt's warning card lands
                // BEFORE the remote turn's live output.
                "runtime.warning",
                "session.state.changed",
                "content.delta",
              ]);
              expect(events[1]).toMatchObject({ eventId: "aether:task-1:remote:u9" });
              expect(events[1]!.type === "runtime.warning" && events[1]!.payload.message).toContain(
                "driven from the app",
              );
              expect(events[3]).toMatchObject({ eventId: "aether:task-1:stream:m9:1" });
            }),
        );
      }),
  );

  it.effect(
    "a durable backlog the eager reconcile ingests is never re-emitted by the live frame it raced",
    () =>
      Effect.gen(function* () {
        const sockets: Array<FakeAdapterSocket> = [];
        let deltaCalls = 0;
        const restClient: AetherRestClient = {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(idleMessageTask),
          getConversationMessages: () => Effect.succeed(messagesPage(idleMessageTask)),
          connectWorkspace: () =>
            Effect.succeed({
              state: "running",
              transport: { websocket_path: "/workspaces/ws-1/ws", preview_token: "t".repeat(32) },
            } as const),
          getConversationDelta: (_taskId, after) =>
            Effect.sync(() => {
              deltaCalls++;
              // Reconnect/backlog: by the time the FIRST live frame of the
              // remote turn is delivered, the durable feed already carries
              // that turn whole — its user row, its assistant item AND its
              // settle (the task is back at awaiting_input).
              return deltaCalls === 1
                ? emptyDelta(idleMessageTask, after)
                : ({
                    task: idleMessageTask,
                    messages: [
                      {
                        id: "u9",
                        role: "user",
                        content: "driven from the app",
                        deliveryStatus: "delivered",
                        timestamp: "t8",
                        sequence: 8,
                      },
                      {
                        id: "m9",
                        role: "assistant",
                        variant: "text",
                        content: "the whole answer",
                        timestamp: "t9",
                        sequence: 9,
                      },
                    ],
                    activity: [],
                    activeProcessingTurn: null,
                    latestSequence: 9,
                    removedMessageIds: [],
                    truncated: false,
                  } satisfies AetherConversationDelta);
            }),
        };
        yield* withAdapter(
          {
            restClient,
            socket: {
              apiBaseUrl: "https://api.runaether.dev",
              apiKey: "aether_test_key",
              timing: { ...zeroSocketTiming, requestTimeoutMs: 60_000 },
              webSocketFactory: () => {
                const socket = diffAnsweringSocket();
                sockets.push(socket);
                return socket;
              },
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              // Six, with `session.exited` as the sentinel: a stale replay of
              // the live frame would land BEFORE it and shift the tail.
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(6),
                Stream.runCollect,
                Effect.forkScoped,
              );
              const session = yield* adapter.startSession(
                startInput({
                  resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
                }),
              );
              yield* settleAdapterPump;
              // The live frame carries the SAME item the durable backlog
              // already holds.
              sockets[0]!.message({ ...wsAssistantDelta, turnId: "u9", messageId: "m9" });
              yield* settleAdapterPump;
              yield* adapter.stopSession(session.threadId);
              const events = yield* Fiber.join(collector);
              const types = events.map((event) => event.type);
              // The eager reconcile runs BEFORE the frame is mapped, so the
              // frame is mapped against a mapper that already ingested the
              // durable twin: the stale delta is swallowed instead of
              // trailing the turn's own settle.
              expect(types).toEqual([
                "session.started",
                "runtime.warning",
                "item.completed",
                "turn.diff.updated",
                "turn.completed",
                "session.exited",
              ]);
              expect(types).not.toContain("content.delta");
              expect(events[1]).toMatchObject({ eventId: "aether:task-1:remote:u9" });
              expect(events[2]).toMatchObject({ eventId: "aether:task-1:item:m9" });
              expect(events[4]).toMatchObject({ turnId: "aether-turn-u9" });
            }),
        );
      }),
  );

  it.effect(
    "one user turn under a random live turnId settles exactly once across BOTH transports",
    () =>
      Effect.gen(function* () {
        // The turn-fragmentation regression: Aether stamps a FRESH random
        // `turnId` on the live agent frames (agent-handlers.ts mints
        // `messageId: crypto.randomUUID()` per dispatch), which is NEVER the
        // durable user-row id (u1) the driver keys the turn by. Both the LIVE
        // settle and the REST-backstop reconcile report the SAME wire turn —
        // exactly one turn.started and one turn.completed must reach the
        // stream, with the mirror diff on that single durable turn.
        const sockets: Array<FakeAdapterSocket> = [];
        let deltaCalls = 0;
        let taskIdle = false;
        const liveWireTurnId = "9d1f0e2a-7777-4abc-8def-0123456789ab";
        const restClient: AetherRestClient = {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(processingTask),
          getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
          connectWorkspace: () =>
            Effect.succeed({
              state: "running",
              transport: { websocket_path: "/workspaces/ws-1/ws", preview_token: "t".repeat(32) },
            } as const),
          getConversationDelta: (_taskId, after) =>
            Effect.sync(() => {
              deltaCalls++;
              // The durable side grounds the turn as u1 via activeProcessingTurn,
              // then flips to message-idle — the REST backstop settle of the
              // same wire turn the live settle also reports.
              return {
                task: taskIdle ? idleMessageTask : processingTask,
                messages: [],
                activity: [],
                activeProcessingTurn: taskIdle
                  ? null
                  : { messageId: "u1", startedAt: "2026-08-08T10:02:00Z" },
                latestSequence: after,
                removedMessageIds: [],
                truncated: false,
              } satisfies AetherConversationDelta;
            }),
        };
        yield* withAdapter(
          {
            restClient,
            socket: {
              apiBaseUrl: "https://api.runaether.dev",
              apiKey: "aether_test_key",
              timing: { ...zeroSocketTiming, requestTimeoutMs: 60_000 },
              webSocketFactory: () => {
                const socket = diffAnsweringSocket();
                sockets.push(socket);
                return socket;
              },
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(6),
                Stream.runCollect,
                Effect.forkScoped,
              );
              yield* adapter.startSession(
                startInput({
                  resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
                }),
              );
              yield* settleAdapterPump;
              // Adoption reconstructed the durable turn as u1.
              expect((yield* adapter.listSessions())[0]!.activeTurnId).toBe("aether-turn-u1");

              // Live output streams under the RANDOM per-dispatch id while the
              // task is still processing — the alias binds it to u1.
              sockets[0]!.message({ ...wsAssistantDelta, turnId: liveWireTurnId, messageId: "m1" });
              yield* settleAdapterPump;

              // The turn completes: the live settle AND the REST-backstop
              // idle flip both report the same wire turn.
              taskIdle = true;
              sockets[0]!.message({ ...wsTurnCompleted, turnId: liveWireTurnId });
              yield* settleAdapterPump;

              const events = yield* Fiber.join(collector);
              const types = events.map((event) => event.type);
              // EXACTLY ONE turn.started and ONE turn.completed — never the
              // FOUR fragmented cycles the two id namespaces used to produce.
              expect(types.filter((type) => type === "turn.started")).toHaveLength(1);
              expect(types.filter((type) => type === "turn.completed")).toHaveLength(1);
              expect(types).toEqual([
                "session.started",
                "turn.started",
                "session.state.changed",
                "content.delta",
                "turn.diff.updated",
                "turn.completed",
              ]);
              // The started, the mirror diff and the settle all name the ONE
              // durable turn u1 — never the random live id. The mirror-applied
              // change therefore lands in the single segment the checkpoint
              // reactor pairs against its pre-turn baseline.
              expect(events.find((event) => event.type === "turn.started")).toMatchObject({
                turnId: "aether-turn-u1",
              });
              expect(events.find((event) => event.type === "turn.diff.updated")).toMatchObject({
                eventId: "aether:task-1:turn:u1:diff",
                turnId: "aether-turn-u1",
              });
              expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
                turnId: "aether-turn-u1",
                payload: { state: "completed" },
              });
              expect(types).not.toContain("runtime.error");
              // The REST backstop actually ran (more than the attach reconcile).
              expect(deltaCalls).toBeGreaterThan(1);
            }),
        );
      }),
  );

  it.effect(
    "an OWN live frame under a random turnId is not read as a remote turn (no early settle)",
    () =>
      Effect.gen(function* () {
        // The own-vs-remote classification used to compare the frame's RAW
        // live turnId — a fresh randomUUID per prompt dispatch — against the
        // DURABLE ids the driver keys turns by, which can never match: every
        // own frame read as a turn injected from the Aether app and fired an
        // eager durable reconcile. This asserts an own CONTENT frame is NOT
        // misclassified (no eager reconcile on it), while settlement is now
        // DURABLE-AUTHORITATIVE: the live turn.completed does not settle the
        // grounded turn itself — it TRIGGERS one immediate reconcile whose
        // durable observation emits the single settle (mirror sync first).
        //
        // The settle poll is parked (a 60s cadence no TestClock beat reaches),
        // so `deltaCalls` counts the attach reconcile (1) plus the terminal
        // frame's triggered reconcile (2). The content frame adding NONE is the
        // proof it was not misclassified as remote.
        const sockets: Array<FakeAdapterSocket> = [];
        let deltaCalls = 0;
        const liveWireTurnId = "3f7c1b90-4444-4def-8abc-fedcba987654";
        const restClient: AetherRestClient = {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(processingTask),
          getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
          connectWorkspace: () =>
            Effect.succeed({
              state: "running",
              transport: { websocket_path: "/workspaces/ws-1/ws", preview_token: "t".repeat(32) },
            } as const),
          getConversationDelta: (_taskId, after) =>
            Effect.sync(() => {
              deltaCalls++;
              // The attach reconcile grounds the durable turn u1. EVERY later
              // read reports the task already parked at message-idle — so a
              // spurious eager reconcile would immediately settle u1 and its
              // turn.completed would precede the turn's own live output.
              return deltaCalls === 1
                ? ({
                    task: processingTask,
                    messages: [],
                    activity: [],
                    activeProcessingTurn: { messageId: "u1", startedAt: "2026-08-08T10:02:00Z" },
                    latestSequence: after,
                    removedMessageIds: [],
                    truncated: false,
                  } satisfies AetherConversationDelta)
                : emptyDelta(idleMessageTask, after);
            }),
        };
        yield* withAdapter(
          {
            restClient,
            turnTiming: { ...zeroTurnTiming, settlePollMs: 60_000 },
            socket: {
              apiBaseUrl: "https://api.runaether.dev",
              apiKey: "aether_test_key",
              timing: { ...zeroSocketTiming, requestTimeoutMs: 60_000 },
              webSocketFactory: () => {
                const socket = diffAnsweringSocket();
                sockets.push(socket);
                return socket;
              },
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(6),
                Stream.runCollect,
                Effect.forkScoped,
              );
              yield* adapter.startSession(
                startInput({
                  resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 7 },
                }),
              );
              yield* settleAdapterPump;
              expect((yield* adapter.listSessions())[0]!.activeTurnId).toBe("aether-turn-u1");
              expect(deltaCalls).toBe(1);

              // An OWN live frame under the random per-dispatch id.
              sockets[0]!.message({ ...wsAssistantDelta, turnId: liveWireTurnId, messageId: "m1" });
              yield* settleAdapterPump;
              // Not remote: no extra reconcile, so no early REST settle …
              expect(deltaCalls).toBe(1);
              // … and the turn is still the one the driver started.
              expect((yield* adapter.listSessions())[0]!.activeTurnId).toBe("aether-turn-u1");

              // The live terminal frame (also under the random id) does not
              // settle the grounded turn itself — it triggers ONE durable
              // reconcile whose observation of the message-idle flip settles u1.
              sockets[0]!.message({ ...wsTurnCompleted, turnId: liveWireTurnId });
              yield* settleAdapterPump;

              const events = yield* Fiber.join(collector);
              const types = events.map((event) => event.type);
              expect(types).toEqual([
                "session.started",
                "turn.started",
                "session.state.changed",
                "content.delta",
                "turn.diff.updated",
                "turn.completed",
              ]);
              // No remote-originated warning was raised for our own frames.
              expect(types).not.toContain("runtime.warning");
              // The settle is DURABLE-sourced on the durable turn, emitted after
              // mirror sync — the terminal frame triggered exactly one extra
              // reconcile (the content frame triggered none).
              expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
                turnId: "aether-turn-u1",
                payload: { state: "completed" },
              });
              // Mirror-sync-then-forward: the applied diff lands in the SAME
              // settled segment (turn.diff.updated keyed to the settled turn,
              // emitted before its turn.completed).
              const diffIndex = types.indexOf("turn.diff.updated");
              expect(diffIndex).toBeGreaterThanOrEqual(0);
              expect(diffIndex).toBeLessThan(types.indexOf("turn.completed"));
              expect(events[diffIndex]).toMatchObject({ turnId: "aether-turn-u1" });
              expect(deltaCalls).toBe(2);
            }),
        );
      }),
  );

  it.effect("does not attach when the thread has no task yet", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeAdapterSocket> = [];
      yield* withAdapter(
        {
          restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
          socket: {
            apiBaseUrl: "https://api.runaether.dev",
            apiKey: "aether_test_key",
            timing: zeroSocketTiming,
            webSocketFactory: () => {
              const socket = new FakeAdapterSocket();
              sockets.push(socket);
              socket.open();
              return socket;
            },
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            yield* adapter.startSession(startInput());
            yield* settleAdapterPump;
            // No task → nothing to attach to until the first sendTurn (T6).
            expect(sockets).toHaveLength(0);
          }),
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// Turn lifecycle (T6, build item 7): create / respond / steer / interrupt
// ---------------------------------------------------------------------------

describe("AetherAdapter turn lifecycle", () => {
  const messageIdleTask: AetherTask = {
    ...processingTask,
    status: "awaiting_input",
    awaiting_input: { kind: "message" },
  };

  const userRow = (id: string, sequence: number): AetherTimelineMessage => ({
    id,
    role: "user",
    content: `message ${id}`,
    deliveryStatus: "delivered",
    timestamp: `t${sequence}`,
    sequence,
  });

  const assistantRow = (id: string, sequence: number): AetherTimelineMessage => ({
    id,
    role: "assistant",
    variant: "text",
    content: `answer ${id}`,
    timestamp: `t${sequence}`,
    sequence,
  });

  const delta = (input: {
    readonly task: AetherTask;
    readonly messages?: ReadonlyArray<AetherTimelineMessage>;
    readonly activeMessageId?: string;
    readonly latestSequence: number;
    readonly removedMessageIds?: ReadonlyArray<string>;
  }): AetherConversationDelta => ({
    task: input.task,
    messages: input.messages ?? [],
    activity: [],
    activeProcessingTurn:
      input.activeMessageId !== undefined
        ? { messageId: input.activeMessageId, startedAt: "2026-08-08T10:02:00Z" }
        : null,
    latestSequence: input.latestSequence,
    removedMessageIds: input.removedMessageIds ?? [],
    truncated: false,
  });

  /** Delta answers scripted per call; the last repeats (reconciles are idempotent). */
  const scriptedDeltas = (answers: ReadonlyArray<AetherConversationDelta>) => {
    let calls = 0;
    return {
      getConversationDelta: (_taskId: string, _after: number) => {
        const answer = answers[Math.min(calls, answers.length - 1)]!;
        calls++;
        return Effect.succeed(answer);
      },
      calls: () => calls,
    };
  };

  const drainPoll = Effect.gen(function* () {
    for (let i = 0; i < 12; i++) {
      yield* TestClock.adjust("0 millis");
      yield* Effect.yieldNow;
    }
  });

  it.effect(
    "first sendTurn creates the task, emits turn.started, settles READY via the backstop",
    () =>
      Effect.gen(function* () {
        const createRequests: Array<unknown> = [];
        const deltas = scriptedDeltas([
          // Harvest: the first user row names turn 1's wire id.
          delta({
            task: processingTask,
            messages: [userRow("u1", 1)],
            activeMessageId: "u1",
            latestSequence: 1,
          }),
          // Backstop settle: assistant output + message-kind idle (READY).
          delta({
            task: messageIdleTask,
            messages: [userRow("u1", 1), assistantRow("a1", 2)],
            latestSequence: 2,
          }),
        ]);
        const registrations: Array<string> = [];
        yield* withAdapter(
          {
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              createTask: (request) =>
                Effect.sync(() => {
                  createRequests.push(request);
                }).pipe(Effect.as({ id: "task-9", name: "Fix the flaky test" })),
              getConversationDelta: deltas.getConversationDelta,
            },
            mirrorRegistry: {
              register: (cwd) => Effect.sync(() => void registrations.push(`+${cwd}`)),
              deregister: (cwd) => Effect.sync(() => void registrations.push(`-${cwd}`)),
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(3),
                Stream.runCollect,
                Effect.forkScoped,
              );
              const session = yield* adapter.startSession(startInput());
              const result = yield* adapter.sendTurn({
                threadId: session.threadId,
                input: "fix the bug",
              });
              expect(result.turnId).toBe("aether-turn-u1");
              expect(result.resumeCursor).toMatchObject({ taskId: "task-9" });

              // The create request carries the spec'd shape.
              expect(createRequests).toHaveLength(1);
              expect(createRequests[0]).toMatchObject({
                project_id: "project-1",
                prompt: "fix the bug",
                base_branch: "feature/demo",
                agent_type: "codex",
                model: "gpt-5.6-sol",
                interaction_mode: "default",
                auto_fix_ci: false,
                auto_fix_pr_comments: false,
                auto_rebase: false,
              });

              // Mid-turn: the session shows the active turn.
              const midTurn = (yield* adapter.listSessions())[0]!;
              expect(midTurn.status).toBe("running");
              expect(midTurn.activeTurnId).toBe("aether-turn-u1");

              yield* drainPoll;

              const events = yield* Fiber.join(collector);
              expect(events.map((event) => event.type)).toEqual([
                "turn.started",
                "item.completed",
                "turn.completed",
              ]);
              expect(events[0]).toMatchObject({
                eventId: "aether:task-9:turn:u1:started",
                turnId: "aether-turn-u1",
                payload: { model: "codex/gpt-5.6-sol" },
              });
              expect(events[2]).toMatchObject({
                turnId: "aether-turn-u1",
                payload: { state: "completed" },
              });
              // The message-kind idle settle maps to READY: deliberately NO
              // session.state.changed (waiting would re-flip to Working).
              expect(events.some((event) => event.type === "session.state.changed")).toBe(false);

              const settled = (yield* adapter.listSessions())[0]!;
              expect(settled.status).toBe("ready");
              expect(settled.activeTurnId).toBeUndefined();

              // The mirror guard owned the cwd from startSession.
              expect(registrations).toEqual(["+/repo"]);
            }),
        );
      }),
  );

  it.effect(
    "bases the managed-worktree task on the recorded fork branch, not the local scratch branch",
    () =>
      Effect.gen(function* () {
        const createRequests: Array<unknown> = [];
        const deltas = scriptedDeltas([
          delta({
            task: processingTask,
            messages: [userRow("u1", 1)],
            activeMessageId: "u1",
            latestSequence: 1,
          }),
          delta({
            task: messageIdleTask,
            messages: [userRow("u1", 1), assistantRow("a1", 2)],
            latestSequence: 2,
          }),
        ]);
        yield* withAdapter(
          {
            // Driver-owned worktree on a local-only scratch branch; its fork
            // base ("main") is recorded in branch.<head>.gh-merge-base.
            git: gitWith(
              { ...cleanStatus, branch: "t3code/abc123", hasUpstream: false, upstreamRef: null },
              "git@github.com:acme/aether.git",
              "main",
            ),
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              createTask: (request) =>
                Effect.sync(() => {
                  createRequests.push(request);
                }).pipe(Effect.as({ id: "task-9", name: "n" })),
              getConversationDelta: deltas.getConversationDelta,
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              yield* adapter.streamEvents.pipe(
                Stream.take(3),
                Stream.runCollect,
                Effect.forkScoped,
              );
              const session = yield* adapter.startSession(
                startInput({ cwd: "/worktrees/thread-1", managedWorktree: true }),
              );
              yield* adapter.sendTurn({ threadId: session.threadId, input: "fix the bug" });
              expect(createRequests).toHaveLength(1);
              // base_branch is the recorded fork base — NOT "t3code/abc123",
              // which exists only locally and would 404 cloud startup.
              expect(createRequests[0]).toMatchObject({ base_branch: "main" });
            }),
        );
      }),
  );

  it.effect(
    "a first turn already settled in the attach reconcile still starts before it completes",
    () =>
      Effect.gen(function* () {
        // The create path forks the socket pipeline, and the attach's
        // onConnected reconcile can settle the turn on its very first beat.
        // The turn must therefore be recorded (mapper + activeTurn +
        // turn.started) BEFORE that fork: a settle observed against an
        // unrecorded turn emits turn.completed with no turn.started ahead of
        // it and strands activeTurn afterwards.
        const sockets: Array<FakeAdapterSocket> = [];
        // activeTurnId as it stood on every conversation-delta call: the
        // harvest (before the turn exists) and then the attach reconcile.
        const activeTurnPerDeltaCall: Array<string | undefined> = [];
        let adapterRef: ProviderAdapterShape<ProviderAdapterError> | undefined;
        const deltas = scriptedDeltas([
          // Harvest: the first user row names turn 1's wire id.
          delta({
            task: processingTask,
            messages: [userRow("u1", 1)],
            activeMessageId: "u1",
            latestSequence: 1,
          }),
          // The attach reconcile already sees the WHOLE turn, settled.
          delta({
            task: messageIdleTask,
            messages: [userRow("u1", 1), assistantRow("a1", 2)],
            latestSequence: 2,
          }),
        ]);
        yield* withAdapter(
          {
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              createTask: () => Effect.succeed({ id: "task-9", name: "n" }),
              getTask: () => Effect.succeed(processingTask),
              connectWorkspace: () =>
                Effect.succeed({
                  state: "running",
                  transport: {
                    websocket_path: "/workspaces/ws-1/ws",
                    preview_token: "t".repeat(32),
                  },
                } as const),
              getConversationDelta: (taskId, after) =>
                Effect.gen(function* () {
                  const answer = deltas.getConversationDelta(taskId, after);
                  const sessions = adapterRef === undefined ? [] : yield* adapterRef.listSessions();
                  activeTurnPerDeltaCall.push(sessions[0]?.activeTurnId);
                  return yield* answer;
                }),
            },
            socket: {
              apiBaseUrl: "https://api.runaether.dev",
              apiKey: "aether_test_key",
              timing: { ...zeroSocketTiming, requestTimeoutMs: 60_000 },
              webSocketFactory: () => {
                const socket = diffAnsweringSocket();
                sockets.push(socket);
                return socket;
              },
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              adapterRef = adapter;
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(5),
                Stream.runCollect,
                Effect.forkScoped,
              );
              const session = yield* adapter.startSession(startInput());
              const result = yield* adapter.sendTurn({
                threadId: session.threadId,
                input: "go",
              });
              expect(result.turnId).toBe("aether-turn-u1");
              yield* drainPoll;

              const events = yield* Fiber.join(collector);
              expect(events.map((event) => event.type)).toEqual([
                "turn.started",
                "session.started",
                "item.completed",
                "turn.diff.updated",
                "turn.completed",
              ]);
              expect(events[0]).toMatchObject({ turnId: "aether-turn-u1" });
              expect(events[4]).toMatchObject({
                turnId: "aether-turn-u1",
                payload: { state: "completed" },
              });
              // The ordering contract itself: the attach reconcile (delta
              // call 2 — the one that carries the settle) ran against an
              // ALREADY-recorded turn. Call 1 is the pre-turn harvest.
              expect(activeTurnPerDeltaCall.slice(0, 2)).toEqual([undefined, "aether-turn-u1"]);
              // The settle landed on the turn the driver had already
              // recorded: no stale active turn survives it.
              const settled = (yield* adapter.listSessions())[0]!;
              expect(settled.status).toBe("ready");
              expect(settled.activeTurnId).toBeUndefined();
            }),
        );
      }),
    { timeout: 15_000 },
  );

  it.effect("a settle into a pending QUESTION emits waiting (unlike message-idle)", () =>
    Effect.gen(function* () {
      const questionTask: AetherTask = {
        ...processingTask,
        status: "awaiting_input",
        awaiting_input: {
          kind: "questions",
          tool_id: "input-1",
          input: { questions: [{ id: "q1", question: "Which db?", options: [] }] },
        },
      };
      const deltas = scriptedDeltas([
        delta({
          task: processingTask,
          messages: [userRow("u1", 1)],
          activeMessageId: "u1",
          latestSequence: 1,
        }),
        delta({ task: questionTask, messages: [userRow("u1", 1)], latestSequence: 1 }),
      ]);
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            createTask: () => Effect.succeed({ id: "task-9", name: "n" }),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(4),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession(startInput());
            yield* adapter.sendTurn({ threadId: session.threadId, input: "go" });
            yield* drainPoll;
            const events = yield* Fiber.join(collector);
            expect(events.map((event) => event.type)).toEqual([
              "turn.started",
              "turn.completed",
              "user-input.requested",
              "session.state.changed",
            ]);
            expect(events[3]).toMatchObject({ payload: { state: "waiting" } });
          }),
      );
    }),
  );

  it.effect(
    "mid-turn send queues: turn.started(T2) deferred until pickup, after turn.completed(T1)",
    () =>
      Effect.gen(function* () {
        const respondRequests: Array<{ taskId: string; request: unknown }> = [];
        const deltas = scriptedDeltas([
          // Tick 1: T1 (m2) still processing.
          delta({ task: processingTask, activeMessageId: "m2", latestSequence: 3 }),
          // Tick 2: remote picked up the queued m3 — T1 displaced.
          delta({ task: processingTask, activeMessageId: "m3", latestSequence: 4 }),
          // Tick 3: m3 settles into idle.
          delta({ task: messageIdleTask, latestSequence: 5 }),
        ]);
        let respondCount = 0;
        yield* withAdapter(
          {
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              getTask: () => Effect.succeed(processingTask),
              getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
              respondToTask: (taskId, request) =>
                Effect.sync(() => {
                  respondRequests.push({ taskId, request });
                  respondCount++;
                }).pipe(Effect.map(() => ({ message_id: respondCount === 1 ? "m2" : "m3" }))),
              getConversationDelta: deltas.getConversationDelta,
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(6),
                Stream.runCollect,
                Effect.forkScoped,
              );
              const session = yield* adapter.startSession(
                startInput({
                  resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
                }),
              );
              const first = yield* adapter.sendTurn({
                threadId: session.threadId,
                input: "turn two",
              });
              expect(first.turnId).toBe("aether-turn-m2");

              // STEER while T1 runs: 202 + queue, activeTurnId flips to T2 NOW,
              // but turn.started(T2) waits for remote pickup.
              const second = yield* adapter.sendTurn({
                threadId: session.threadId,
                input: "steer it",
              });
              expect(second.turnId).toBe("aether-turn-m3");
              expect((yield* adapter.listSessions())[0]!.activeTurnId).toBe("aether-turn-m3");
              // Both responds carried deterministic idempotency keys.
              expect(respondRequests).toHaveLength(2);
              for (const { request } of respondRequests) {
                expect((request as { client_message_id?: string }).client_message_id).toMatch(
                  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                );
              }

              yield* drainPoll;
              const events = yield* Fiber.join(collector);
              expect(events.map((event) => `${event.type}:${String(event.turnId ?? "")}`)).toEqual([
                "turn.started:aether-turn-m2",
                // The backstop poll projects processing → running.
                "session.state.changed:",
                // The queued/steering contract: completed(T1) strictly before
                // started(T2), started(T2) only on observed pickup.
                "turn.completed:aether-turn-m2",
                "session.state.changed:",
                "turn.started:aether-turn-m3",
                "turn.completed:aether-turn-m3",
              ]);
            }),
        );
      }),
  );

  it.effect("interrupt discards the queued follow-up and the thread stays idle", () =>
    Effect.gen(function* () {
      const stops: Array<{ taskId: string; discard: boolean }> = [];
      const deltas = scriptedDeltas([
        delta({ task: processingTask, activeMessageId: "m2", latestSequence: 3 }),
      ]);
      let respondCount = 0;
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            // Interrupt confirmation: the task has already left processing.
            getTask: () => Effect.succeed(messageIdleTask),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            respondToTask: () =>
              Effect.sync(() => {
                respondCount++;
              }).pipe(Effect.map(() => ({ message_id: respondCount === 1 ? "m2" : "m3" }))),
            stopTask: (taskId, input) =>
              Effect.sync(() => {
                stops.push({ taskId, discard: input.discardQueuedMessages });
              }),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
              }),
            );
            yield* adapter.sendTurn({ threadId: session.threadId, input: "turn two" });
            // Queue a follow-up, then stop: the follow-up is discarded and
            // re-offered as text.
            yield* adapter.sendTurn({ threadId: session.threadId, input: "queued follow-up" });
            yield* adapter.interruptTurn(session.threadId);

            expect(stops).toEqual([{ taskId: "task-1", discard: true }]);

            const events = yield* Fiber.join(collector);
            expect(events.map((event) => event.type)).toEqual([
              "turn.started",
              "runtime.warning",
              "turn.completed",
            ]);
            expect(events[1]!.type === "runtime.warning" && events[1]!.payload.message).toContain(
              "queued follow-up",
            );
            expect(events[2]).toMatchObject({
              turnId: "aether-turn-m2",
              payload: { state: "interrupted" },
            });

            // The thread stays idle: no deferred turn.started(T2) fires later.
            yield* drainPoll;
            const after = (yield* adapter.listSessions())[0]!;
            expect(after.status).toBe("ready");
            expect(after.activeTurnId).toBeUndefined();
            const extra = yield* adapter.streamEvents.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            );
            yield* drainPoll;
            yield* Fiber.interrupt(extra);
          }),
      );
    }),
  );

  it.effect(
    "a failed first-turn harvest never double-sends: the retry re-enters the create path",
    () =>
      Effect.gen(function* () {
        // createTask succeeded but the turn-1 harvest failed — the task exists
        // and carries the prompt. A retry must NOT take the respond path (that
        // re-sends the prompt as a second message) and must NOT create again:
        // it re-harvests. A retry with DIFFERENT text refuses loudly.
        let createCalls = 0;
        let deltaCalls = 0;
        yield* withAdapter(
          {
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              getTask: () => Effect.succeed(processingTask),
              createTask: () =>
                Effect.suspend(() => {
                  createCalls++;
                  return Effect.succeed({ id: "task-9", name: "n" });
                }),
              respondToTask: () =>
                Effect.die("respondToTask must not be called on a pending first turn"),
              connectWorkspace: () =>
                Effect.succeed({
                  state: "running",
                  transport: {
                    websocket_path: "/workspaces/ws-1/ws",
                    preview_token: "t".repeat(32),
                  },
                } as const),
              getConversationDelta: () =>
                Effect.suspend(() => {
                  deltaCalls++;
                  // The first sendTurn's harvest fails (transport errors fail
                  // fast); the retry's harvest succeeds with the opening row.
                  if (deltaCalls === 1) {
                    return Effect.fail(
                      new AetherApiTransportError({
                        endpoint: "/tasks/task-9/conversation/delta",
                        detail: "socket hangup",
                      }),
                    );
                  }
                  return Effect.succeed(
                    delta({
                      task: processingTask,
                      messages: [userRow("u1", 1)],
                      latestSequence: 1,
                    }),
                  );
                }),
            },
            socket: {
              apiBaseUrl: "https://api.runaether.dev",
              apiKey: "aether_test_key",
              timing: zeroSocketTiming,
              webSocketFactory: () => diffAnsweringSocket(),
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const session = yield* adapter.startSession(startInput());
              const failure = yield* Effect.flip(
                adapter.sendTurn({ threadId: session.threadId, input: "go" }),
              );
              expect(failure._tag).toBe("ProviderAdapterRequestError");
              // Different text while pending → refused, nothing dispatched.
              const mismatch = yield* Effect.flip(
                adapter.sendTurn({ threadId: session.threadId, input: "something else" }),
              );
              expect(mismatch._tag).toBe("ProviderAdapterValidationError");
              // Same text → re-enters the first-turn path: no second create,
              // no respond, harvest retried and the turn comes up.
              const result = yield* adapter.sendTurn({ threadId: session.threadId, input: "go" });
              expect(result.turnId).toBe("aether-turn-u1");
              expect(createCalls).toBe(1);
            }),
        );
      }),
  );

  it.effect("a failed respond does not burn the client_message_id — the retry can dedupe", () =>
    Effect.gen(function* () {
      // The idempotency key exists for exactly one scenario: a respond whose
      // 202 was lost in transit and is then re-sent. The ordinal must only
      // advance on a CONFIRMED 202, so the retry reuses the same id and the
      // server's ON CONFLICT dedupe can fire.
      const seenIds: Array<string> = [];
      let failFirst = true;
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: () => Effect.succeed(messageIdleTask),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            respondToTask: (_taskId, request) =>
              Effect.suspend(() => {
                seenIds.push((request as { client_message_id: string }).client_message_id);
                if (failFirst) {
                  failFirst = false;
                  return Effect.fail(
                    new AetherApiNotFoundError({
                      endpoint: "/tasks/task-1/respond",
                      detail: "lost",
                    }),
                  );
                }
                return Effect.succeed({ message_id: "m2" });
              }),
            getConversationDelta: scriptedDeltas([
              delta({ task: messageIdleTask, latestSequence: 3 }),
            ]).getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
              }),
            );
            const failure = yield* Effect.flip(
              adapter.sendTurn({ threadId: session.threadId, input: "send it" }),
            );
            expect(failure._tag).toBe("ProviderAdapterRequestError");
            yield* adapter.sendTurn({ threadId: session.threadId, input: "send it" });
            expect(seenIds).toHaveLength(2);
            expect(seenIds[0]).toBe(seenIds[1]);
          }),
      );
    }),
  );

  it.effect("interrupt with ONLY a queued follow-up settles it — the session never wedges", () =>
    Effect.gen(function* () {
      const stops: Array<{ taskId: string; discard: boolean }> = [];
      const deltas = scriptedDeltas([
        // Tick 1: T1 (m2) processing.
        delta({ task: processingTask, activeMessageId: "m2", latestSequence: 3 }),
        // Tick 2+: T1 settled WITHOUT the queued m3 being picked up.
        delta({ task: messageIdleTask, latestSequence: 4 }),
      ]);
      let respondCount = 0;
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: () => Effect.succeed(messageIdleTask),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            respondToTask: () =>
              Effect.sync(() => {
                respondCount++;
              }).pipe(Effect.map(() => ({ message_id: respondCount === 1 ? "m2" : "m3" }))),
            stopTask: (taskId, input) =>
              Effect.sync(() => {
                stops.push({ taskId, discard: input.discardQueuedMessages });
              }),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(5),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
              }),
            );
            yield* adapter.sendTurn({ threadId: session.threadId, input: "turn two" });
            yield* adapter.sendTurn({ threadId: session.threadId, input: "queued follow-up" });
            // T1 settles naturally via the backstop; m3 stays queued, so the
            // session keeps running on the deferred turn.
            yield* drainPoll;
            const mid = (yield* adapter.listSessions())[0]!;
            expect(mid.status).toBe("running");
            expect(mid.activeTurnId).toBe("aether-turn-m3");

            // Stop with NO active turn — only the deferred steer exists.
            yield* adapter.interruptTurn(session.threadId);
            expect(stops).toEqual([{ taskId: "task-1", discard: true }]);

            const events = yield* Fiber.join(collector);
            expect(events.map((event) => event.type)).toEqual([
              "turn.started",
              "session.state.changed",
              "turn.completed",
              "runtime.warning",
              // The discarded queued turn gets its OWN terminal settle —
              // without it the session stays running on a turn that no
              // longer exists and a second Stop has nothing to grab.
              "turn.completed",
            ]);
            expect(events[2]).toMatchObject({
              turnId: "aether-turn-m2",
              payload: { state: "completed" },
            });
            expect(events[4]).toMatchObject({
              turnId: "aether-turn-m3",
              payload: { state: "interrupted" },
            });

            const after = (yield* adapter.listSessions())[0]!;
            expect(after.status).toBe("ready");
            expect(after.activeTurnId).toBeUndefined();
            // Nothing left to interrupt — the wedge would have kept this alive.
            const second = yield* Effect.flip(adapter.interruptTurn(session.threadId));
            expect(second.message).toContain("No Aether turn is active");
          }),
      );
    }),
  );

  it.effect("a failed stop does NOT falsify the turn's natural settle into 'interrupted'", () =>
    Effect.gen(function* () {
      const deltas = scriptedDeltas([
        delta({ task: processingTask, activeMessageId: "m2", latestSequence: 3 }),
        delta({ task: messageIdleTask, latestSequence: 4 }),
      ]);
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: () => Effect.succeed(messageIdleTask),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            respondToTask: () => Effect.succeed({ message_id: "m2" }),
            stopTask: () =>
              Effect.fail(
                new AetherApiNotFoundError({ endpoint: "/tasks/task-1/stop", detail: "gone" }),
              ),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
              }),
            );
            yield* adapter.sendTurn({ threadId: session.threadId, input: "turn two" });
            const failure = yield* Effect.flip(adapter.interruptTurn(session.threadId));
            expect(failure._tag).toBe("ProviderAdapterRequestError");

            // The remote turn kept running and settles NATURALLY — the
            // aborted interrupt must not have pre-marked it, or this settle
            // would lie 'interrupted' for a turn that ran to completion.
            yield* drainPoll;
            const events = yield* Fiber.join(collector);
            expect(events.at(-1)).toMatchObject({
              turnId: "aether-turn-m2",
              payload: { state: "completed" },
            });
          }),
      );
    }),
  );

  it.effect("rejects unsupported and oversize attachments BEFORE any API call", () =>
    withAdapter(
      {
        // createTask/respondToTask stay defects: reaching them fails the test.
        restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(startInput());
          const unsupported = yield* Effect.flip(
            adapter.sendTurn({
              threadId: session.threadId,
              input: "see image",
              attachments: [
                {
                  type: "image",
                  id: "thread-1-00000000-0000-4000-8000-000000000000",
                  name: "scan.tiff",
                  mimeType: "image/tiff",
                  sizeBytes: 10,
                },
              ],
            }),
          );
          expect(unsupported._tag).toBe("ProviderAdapterValidationError");
          expect(unsupported.message).toContain("image/tiff");

          const oversize = yield* Effect.flip(
            adapter.sendTurn({
              threadId: session.threadId,
              input: "see image",
              attachments: [
                {
                  type: "image",
                  id: "thread-1-00000000-0000-4000-8000-000000000001",
                  name: "big.png",
                  mimeType: "image/png",
                  sizeBytes: 6 * 1024 * 1024,
                },
              ],
            }),
          );
          expect(oversize._tag).toBe("ProviderAdapterValidationError");
          expect(oversize.message).toContain("5 MiB");
        }),
    ),
  );

  it.effect("rejects an empty prompt loudly", () =>
    withAdapter(
      { restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) } },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(startInput());
          const error = yield* Effect.flip(adapter.sendTurn({ threadId: session.threadId }));
          expect(error._tag).toBe("ProviderAdapterValidationError");
          expect(error.message).toContain("non-empty text prompt");
        }),
    ),
  );

  // -- questions + plans (T7) -----------------------------------------------

  const optionsQuestionTask: AetherTask = {
    ...processingTask,
    status: "awaiting_input",
    awaiting_input: {
      kind: "questions",
      tool_id: "input-1",
      input: {
        questions: [
          {
            id: "q1",
            question: "Which approach?",
            options: [{ label: "Patch" }, { label: "Rewrite" }],
          },
          { id: "q2", question: "Anything else?", options: [] },
        ],
      },
    },
  };

  const planPendingTask: AetherTask = {
    ...processingTask,
    status: "awaiting_input",
    awaiting_input: {
      kind: "plan",
      tool_id: "plan-1",
      input: { summary: "Fix it", plan: "1. Reproduce\n2. Fix" },
    },
  };

  it.effect(
    "respondToUserInput maps labels to raw indices, uses the -1 custom sentinel, resumes the turn",
    () =>
      Effect.gen(function* () {
        const respondRequests: Array<unknown> = [];
        const deltas = scriptedDeltas([
          delta({
            task: processingTask,
            messages: [userRow("u1", 1)],
            activeMessageId: "u1",
            latestSequence: 1,
          }),
          delta({ task: optionsQuestionTask, messages: [userRow("u1", 1)], latestSequence: 1 }),
        ]);
        yield* withAdapter(
          {
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              createTask: () => Effect.succeed({ id: "task-9", name: "n" }),
              respondToTask: (_taskId, request) =>
                Effect.sync(() => {
                  respondRequests.push(request);
                }).pipe(Effect.as({ message_id: "m2" })),
              getConversationDelta: deltas.getConversationDelta,
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(6),
                Stream.runCollect,
                Effect.forkScoped,
              );
              const session = yield* adapter.startSession(startInput());
              yield* adapter.sendTurn({ threadId: session.threadId, input: "go" });
              yield* drainPoll;

              yield* adapter.respondToUserInput(
                session.threadId,
                ApprovalRequestId.make("input-1"),
                { q1: "Rewrite", q2: "use sqlite instead" },
              );

              // The aether-exact wire shape: answers keyed by RAW question
              // index, labels resolved to raw option indices, free-typed
              // text as the -1 sentinel + customAnswers (tasks.go oneOf).
              const expectedData = {
                answers: { "0": [1], "1": [-1] },
                customAnswers: { "1": "use sqlite instead" },
              };
              expect(respondRequests).toHaveLength(1);
              expect(respondRequests[0]).toMatchObject({
                // @effect-diagnostics-next-line preferSchemaOverJson:off - asserts the wire-exact transcript row aether-web writes.
                message: JSON.stringify(expectedData),
                tool_response: { tool_name: "ask_user", data: expectedData },
              });
              expect(
                (respondRequests[0] as { client_message_id?: string }).client_message_id,
              ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

              const events = yield* Fiber.join(collector);
              expect(events.map((event) => event.type)).toEqual([
                "turn.started",
                "turn.completed",
                "user-input.requested",
                "session.state.changed",
                // The panel resolves BEFORE the resumed turn is announced.
                "user-input.resolved",
                "turn.started",
              ]);
              expect(events[4]).toMatchObject({
                requestId: "input-1",
                payload: { answers: { q1: "Rewrite", q2: "use sqlite instead" } },
              });
              expect(events[5]).toMatchObject({ turnId: "aether-turn-m2" });

              // The ledger carries both driver-originated turns.
              const settled = (yield* adapter.listSessions())[0]!;
              expect(settled.resumeCursor).toMatchObject({
                turnLedger: [
                  { turnId: "aether-turn-u1", messageId: "u1" },
                  { turnId: "aether-turn-m2", messageId: "m2" },
                ],
              });
            }),
        );
      }),
  );

  it.effect("respondToUserInput with a stale requestId renders as t3's stale-request error", () =>
    withAdapter(
      {
        restClient: {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(messageIdleTask),
          getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
        },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput({
              resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
            }),
          );
          const failure = yield* Effect.flip(
            adapter.respondToUserInput(session.threadId, ApprovalRequestId.make("input-gone"), {
              q1: "yes",
            }),
          );
          expect(failure._tag).toBe("ProviderAdapterRequestError");
          // The EXACT substring t3's reactor/decider key their stale
          // rendering on ("Stale pending user-input request … restart").
          expect(failure.message).toContain("unknown pending user-input request");
        }),
    ),
  );

  it.effect(
    "a 409 on the answer classifies as a stale request AND carries the body's message",
    () =>
      Effect.gen(function* () {
        const deltas = scriptedDeltas([
          delta({
            task: processingTask,
            messages: [userRow("u1", 1)],
            activeMessageId: "u1",
            latestSequence: 1,
          }),
          delta({ task: optionsQuestionTask, messages: [userRow("u1", 1)], latestSequence: 1 }),
        ]);
        yield* withAdapter(
          {
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              createTask: () => Effect.succeed({ id: "task-9", name: "n" }),
              respondToTask: () =>
                Effect.fail(
                  new AetherApiConflictError({
                    endpoint: "POST /tasks/{id}/respond",
                    detail: "Task is no longer awaiting input",
                    code: "task_not_accepting_messages",
                  }),
                ),
              getConversationDelta: deltas.getConversationDelta,
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const session = yield* adapter.startSession(startInput());
              yield* adapter.sendTurn({ threadId: session.threadId, input: "go" });
              yield* drainPoll;
              const failure = yield* Effect.flip(
                adapter.respondToUserInput(session.threadId, ApprovalRequestId.make("input-1"), {
                  q1: "Patch",
                }),
              );
              expect(failure._tag).toBe("ProviderAdapterRequestError");
              // Spec §2.4: the 409 path MUST carry the exact substring t3's
              // stale-request machinery (reactor/decider/projection) keys on —
              // the decoded body's message rides along for context.
              expect(failure.message).toContain("unknown pending user-input request");
              expect(failure.message).toContain("Task is no longer awaiting input");
            }),
        );
      }),
  );

  it.effect("a sendTurn while a plan is pending ACCEPTS it (interactionMode default)", () =>
    Effect.gen(function* () {
      const respondRequests: Array<unknown> = [];
      const deltas = scriptedDeltas([
        delta({
          task: processingTask,
          messages: [userRow("u1", 1)],
          activeMessageId: "u1",
          latestSequence: 1,
        }),
        delta({ task: planPendingTask, messages: [userRow("u1", 1)], latestSequence: 1 }),
      ]);
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            createTask: () => Effect.succeed({ id: "task-9", name: "n" }),
            respondToTask: (_taskId, request) =>
              Effect.sync(() => {
                respondRequests.push(request);
              }).pipe(Effect.as({ message_id: "m2" })),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(4),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession(startInput());
            yield* adapter.sendTurn({ threadId: session.threadId, input: "plan it" });
            yield* drainPoll;
            const events = yield* Fiber.join(collector);
            expect(events.map((event) => event.type)).toEqual([
              "turn.started",
              "turn.completed",
              "turn.proposed.completed",
              "session.state.changed",
            ]);

            const accept = yield* adapter.sendTurn({
              threadId: session.threadId,
              input: "build it",
              interactionMode: "default",
            });
            expect(accept.turnId).toBe("aether-turn-m2");
            expect(respondRequests).toHaveLength(1);
            expect(respondRequests[0]).toMatchObject({
              message: "build it",
              interaction_mode: "default",
              tool_response: { tool_name: "propose_plan", data: { approved: true } },
            });
            expect(
              (respondRequests[0] as { tool_response: { data: Record<string, unknown> } })
                .tool_response.data.feedback,
            ).toBeUndefined();
          }),
      );
    }),
  );

  it.effect("a plan-mode follow-up REJECTS the pending plan with feedback", () =>
    Effect.gen(function* () {
      const respondRequests: Array<unknown> = [];
      const deltas = scriptedDeltas([
        delta({
          task: processingTask,
          messages: [userRow("u1", 1)],
          activeMessageId: "u1",
          latestSequence: 1,
        }),
        delta({ task: planPendingTask, messages: [userRow("u1", 1)], latestSequence: 1 }),
      ]);
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            createTask: () => Effect.succeed({ id: "task-9", name: "n" }),
            respondToTask: (_taskId, request) =>
              Effect.sync(() => {
                respondRequests.push(request);
              }).pipe(Effect.as({ message_id: "m2" })),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const session = yield* adapter.startSession(startInput());
            yield* adapter.sendTurn({ threadId: session.threadId, input: "plan it" });
            yield* drainPoll;
            yield* adapter.sendTurn({
              threadId: session.threadId,
              input: "tighten the rollout steps",
              interactionMode: "plan",
            });
            expect(respondRequests).toHaveLength(1);
            expect(respondRequests[0]).toMatchObject({
              message: "tighten the rollout steps",
              interaction_mode: "plan",
              tool_response: {
                tool_name: "propose_plan",
                data: { approved: false, feedback: "tighten the rollout steps" },
              },
            });
          }),
      );
    }),
  );

  // -- hardening + steer-queue polish (T8) ------------------------------------

  it.effect(
    "an unledgered user row surfaces as a remote-originated warning before its output",
    () =>
      Effect.gen(function* () {
        const deltas = scriptedDeltas([
          delta({ task: processingTask, activeMessageId: "m2", latestSequence: 3 }),
          delta({
            task: messageIdleTask,
            messages: [userRow("remote-1", 5), assistantRow("a5", 6)],
            latestSequence: 6,
          }),
        ]);
        let respondCount = 0;
        yield* withAdapter(
          {
            restClient: {
              ...unusedRestClient,
              listProjects: () => Effect.succeed([project()]),
              getTask: () => Effect.succeed(processingTask),
              getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
              respondToTask: () =>
                Effect.sync(() => {
                  respondCount++;
                }).pipe(Effect.map(() => ({ message_id: `m${respondCount + 1}` }))),
              getConversationDelta: deltas.getConversationDelta,
            },
          },
          (adapter) =>
            Effect.gen(function* () {
              const collector = yield* adapter.streamEvents.pipe(
                Stream.take(6),
                Stream.runCollect,
                Effect.forkScoped,
              );
              const session = yield* adapter.startSession(
                startInput({
                  resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
                }),
              );
              yield* adapter.sendTurn({ threadId: session.threadId, input: "turn two" });
              yield* drainPoll;
              const events = yield* Fiber.join(collector);
              const types = events.map((event) => event.type);
              const warningIndex = types.indexOf("runtime.warning");
              const outputIndex = types.indexOf("item.completed");
              expect(warningIndex).toBeGreaterThanOrEqual(0);
              // The injected prompt lands BEFORE the turn's output.
              expect(warningIndex).toBeLessThan(outputIndex);
              const warning = events[warningIndex]!;
              expect(warning.eventId).toBe("aether:task-1:remote:remote-1");
              expect(warning.type === "runtime.warning" && warning.payload.message).toContain(
                "This task was driven from the Aether app: message remote-1",
              );
            }),
        );
      }),
  );

  it.effect("a reconcile racing the steer's 202 does NOT misclassify the driver's own row", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let respondCount = 0;
      let sessionEpoch = "";
      let steerRowVisible = false;
      let taskIdlePhase = false;
      const getDelta = (_taskId: string, _after: number) =>
        Effect.sync(() =>
          taskIdlePhase
            ? delta({ task: messageIdleTask, latestSequence: 6 })
            : steerRowVisible
              ? delta({
                  task: processingTask,
                  activeMessageId: "m2",
                  messages: [
                    {
                      id: "m3",
                      role: "user",
                      content: "steer it",
                      deliveryStatus: "queued",
                      timestamp: "t5",
                      sequence: 5,
                      // The row the server committed for the in-flight steer
                      // carries the driver's own deterministic id.
                      clientMessageId: deterministicClientMessageId({
                        taskId: "task-1",
                        sessionEpoch,
                        sendOrdinal: 1,
                      }),
                    },
                  ],
                  latestSequence: 5,
                })
              : delta({ task: processingTask, activeMessageId: "m2", latestSequence: 3 }),
        );
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: () => Effect.succeed(processingTask),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            respondToTask: () =>
              Effect.suspend(() => {
                respondCount++;
                if (respondCount === 1) {
                  return Effect.succeed({ message_id: "m2" });
                }
                // The server commits the user row BEFORE returning the 202 —
                // from this moment the settle poll can observe it while the
                // steer's sendTurn still awaits the response.
                steerRowVisible = true;
                return Deferred.await(gate).pipe(Effect.as({ message_id: "m3" }));
              }),
            getConversationDelta: getDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
              }),
            );
            sessionEpoch = session.createdAt;
            yield* adapter.sendTurn({ threadId: session.threadId, input: "turn two" });
            const steer = yield* Effect.forkScoped(
              adapter.sendTurn({ threadId: session.threadId, input: "steer it" }),
            );
            // Poll beats run while the 202 is still parked on the gate: they
            // observe the committed steer row (not yet in the turn ledger).
            yield* drainPoll;
            yield* Deferred.succeed(gate, undefined);
            yield* Fiber.join(steer);
            taskIdlePhase = true;
            yield* drainPoll;
            const events = yield* Fiber.join(collector);
            // The pre-registered client_message_id classifies the row as the
            // driver's own send — with the ledger entry landing only after
            // the 202, a post-202 registration would have surfaced a false
            // "driven from the Aether app" warning here instead of the
            // settle.
            expect(events.map((event) => event.type)).toEqual([
              "turn.started",
              "session.state.changed",
              "turn.completed",
            ]);
            expect(events[2]).toMatchObject({
              turnId: "aether-turn-m2",
              payload: { state: "completed" },
            });
          }),
      );
    }),
  );

  it.effect("a queued steer unqueued remotely settles its deferred turn (removedMessageIds)", () =>
    Effect.gen(function* () {
      const deltas = scriptedDeltas([
        delta({ task: processingTask, activeMessageId: "m2", latestSequence: 3 }),
        // The remote unqueue never surfaces as a row — cancelled user
        // messages are filtered out of the conversation wire entirely; the
        // ONLY signal is the id landing in the delta's removedMessageIds
        // (the cancel bumps the revision sequence).
        delta({
          task: processingTask,
          activeMessageId: "m2",
          removedMessageIds: ["m3"],
          latestSequence: 5,
        }),
      ]);
      let respondCount = 0;
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: () => Effect.succeed(processingTask),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            respondToTask: () =>
              Effect.sync(() => {
                respondCount++;
              }).pipe(Effect.map(() => ({ message_id: respondCount === 1 ? "m2" : "m3" }))),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const collector = yield* adapter.streamEvents.pipe(
              Stream.take(4),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
              }),
            );
            yield* adapter.sendTurn({ threadId: session.threadId, input: "turn two" });
            yield* adapter.sendTurn({ threadId: session.threadId, input: "steer it" });
            yield* drainPoll;
            const events = yield* Fiber.join(collector);
            expect(events.map((event) => event.type)).toEqual([
              "turn.started",
              "session.state.changed",
              "runtime.warning",
              "turn.completed",
            ]);
            expect(events[2]!.type === "runtime.warning" && events[2]!.payload.message).toContain(
              "steer it",
            );
            expect(events[3]).toMatchObject({
              turnId: "aether-turn-m3",
              payload: { state: "interrupted" },
            });
            // The session falls back to the still-running predecessor
            // instead of staying wedged on the cancelled steer.
            const after = (yield* adapter.listSessions())[0]!;
            expect(after.status).toBe("running");
            expect(after.activeTurnId).toBe("aether-turn-m2");
          }),
      );
    }),
  );

  it.effect("a model change between turns PUTs the full settings replace, then responds", () =>
    Effect.gen(function* () {
      const updates: Array<unknown> = [];
      const respondRequests: Array<unknown> = [];
      const deltas = scriptedDeltas([delta({ task: messageIdleTask, latestSequence: 3 })]);
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            getTask: () => Effect.succeed(messageIdleTask),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            updateTask: (_taskId, request) =>
              Effect.sync(() => {
                updates.push(request);
              }).pipe(Effect.as(messageIdleTask)),
            respondToTask: (_taskId, request) =>
              Effect.sync(() => {
                respondRequests.push(request);
              }).pipe(Effect.as({ message_id: "m2" })),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            expect(adapter.capabilities.sessionModelSwitch).toBe("in-session");
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
              }),
            );
            yield* adapter.sendTurn({
              threadId: session.threadId,
              input: "switch to claude",
              modelSelection: { instanceId, model: "claude-code/claude-opus-5" },
            });
            // FULL replace (every field required; reasoning_effort is
            // required-but-nullable), with the live-mutable auto_fix_* flags
            // read back from the task row, never assumed false.
            expect(updates).toEqual([
              {
                agent_type: "claude-code",
                model: "claude-opus-5",
                interaction_mode: "default",
                reasoning_effort: null,
                auto_fix_ci: false,
                auto_fix_pr_comments: false,
                auto_rebase: false,
              },
            ]);
            expect(respondRequests).toHaveLength(1);
            const after = (yield* adapter.listSessions())[0]!;
            expect(after.model).toBe("claude-code/claude-opus-5");
          }),
      );
    }),
  );

  it.effect("a reasoning-effort change on the SAME model slug rides every respond", () =>
    Effect.gen(function* () {
      const respondRequests: Array<unknown> = [];
      const deltas = scriptedDeltas([delta({ task: messageIdleTask, latestSequence: 3 })]);
      yield* withAdapter(
        {
          restClient: {
            ...unusedRestClient,
            listProjects: () => Effect.succeed([project()]),
            // updateTask stays the defecting stub on purpose: an option-only
            // change must never take the full-replace PUT path (which is
            // refused outright while a turn is running).
            getTask: () => Effect.succeed(messageIdleTask),
            getConversationMessages: () => Effect.succeed(messagesPage(processingTask)),
            respondToTask: (_taskId, request) =>
              Effect.sync(() => {
                respondRequests.push(request);
                return { message_id: `m${respondRequests.length + 1}` };
              }),
            getConversationDelta: deltas.getConversationDelta,
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const session = yield* adapter.startSession(
              startInput({
                resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 2 },
              }),
            );
            // The project defaults name the session's slug; only the effort
            // OPTION moves between the two sends.
            const selection = (effort: string) => ({
              instanceId,
              model: "codex/gpt-5.6-sol",
              options: [{ id: "reasoningEffort", value: effort }],
            });
            yield* adapter.sendTurn({
              threadId: session.threadId,
              input: "think harder",
              modelSelection: selection("high"),
            });
            yield* adapter.sendTurn({
              threadId: session.threadId,
              input: "actually, be quick",
              modelSelection: selection("low"),
            });
            // `POST /respond` carries the per-message reasoning_effort the
            // runner reads; without it the second turn would inherit the
            // task row's stored effort.
            expect(respondRequests).toMatchObject([
              { message: "think harder", reasoning_effort: "high" },
              { message: "actually, be quick", reasoning_effort: "low" },
            ]);
            expect((yield* adapter.listSessions())[0]!.model).toBe("codex/gpt-5.6-sol");
          }),
      );
    }),
  );

  it.effect("stopSession deregisters the mirror-guard claim", () =>
    Effect.gen(function* () {
      const registrations: Array<string> = [];
      yield* withAdapter(
        {
          restClient: { ...unusedRestClient, listProjects: () => Effect.succeed([project()]) },
          mirrorRegistry: {
            register: (cwd, key) => Effect.sync(() => void registrations.push(`+${cwd}:${key}`)),
            deregister: (cwd, key) => Effect.sync(() => void registrations.push(`-${cwd}:${key}`)),
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const session = yield* adapter.startSession(startInput());
            yield* adapter.stopSession(session.threadId);
          }),
      );
      expect(registrations).toEqual(["+/repo:aether:thread-1", "-/repo:aether:thread-1"]);
    }),
  );
});
