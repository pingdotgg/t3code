import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
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
  makeAetherAdapter,
  parseAetherResume,
  type AetherAdapterSocketOptions,
  type AetherMirrorRegistration,
  type AetherSessionGit,
  type AetherTurnTiming,
} from "./AetherAdapter.ts";
import {
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
): AetherSessionGit => ({
  statusDetails: () => Effect.succeed(status),
  readConfigValue: (_cwd, key) => Effect.succeed(key === "remote.origin.url" ? originUrl : null),
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
  latest_sequence: 12,
  status: "processing",
  run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:01:00Z" },
};

const startInput = (overrides?: {
  readonly resumeCursor?: unknown;
  readonly modelSelection?: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly threadId?: ThreadId;
}) => ({
  threadId: overrides?.threadId ?? ThreadId.make("thread-1"),
  cwd: "/repo",
  runtimeMode: "full-access" as const,
  ...(overrides?.resumeCursor !== undefined ? { resumeCursor: overrides.resumeCursor } : {}),
  ...(overrides?.modelSelection !== undefined ? { modelSelection: overrides.modelSelection } : {}),
});

const withAdapter = <A, E>(
  options: {
    readonly git?: AetherSessionGit;
    readonly restClient?: AetherRestClient | undefined;
    readonly hasRestClient?: boolean;
    readonly socket?: AetherAdapterSocketOptions;
    readonly mirrorRegistry?: AetherMirrorRegistration;
  },
  use: (adapter: ProviderAdapterShape<ProviderAdapterError>) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const adapter = yield* makeAetherAdapter({
      instanceId,
      defaultCwd: "/default-cwd",
      git: options.git ?? gitWith(cleanStatus),
      attachmentsDir: "/nonexistent-attachments-dir",
      mirrorRegistry: options.mirrorRegistry ?? noopMirrorRegistry,
      restClient:
        options.hasRestClient === false ? undefined : (options.restClient ?? unusedRestClient),
      socket: options.socket,
      turnTiming: zeroTurnTiming,
    });
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
  it("parses a current-version cursor and preserves the opaque turn ledger", () => {
    expect(
      parseAetherResume({
        schemaVersion: 1,
        taskId: "task-1",
        latestSequence: 12,
        turnLedger: [{ turn: 1 }],
      }),
    ).toEqual({
      schemaVersion: 1,
      taskId: "task-1",
      latestSequence: 12,
      turnLedger: [{ turn: 1 }],
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

  it.effect("round-trips an opaque turn ledger through the rebuilt resume cursor", () =>
    withAdapter(
      {
        restClient: {
          ...unusedRestClient,
          listProjects: () => Effect.succeed([project()]),
          getTask: () => Effect.succeed(processingTask),
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
                turnLedger: [{ turn: 1, messageId: "m-1" }],
              },
            }),
          );
          // A ledger written by a newer build (item 10) must survive a
          // startSession round-trip through this one.
          expect(session.resumeCursor).toEqual({
            schemaVersion: 1,
            taskId: "task-1",
            latestSequence: 7,
            turnLedger: [{ turn: 1, messageId: "m-1" }],
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

  it.effect("turn methods fail session-not-found for unknown threads; T7+ stubs stay loud", () =>
    withAdapter({}, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-1");
        const sendTurn = yield* Effect.flip(adapter.sendTurn({ threadId, input: "hi" }));
        expect(sendTurn._tag).toBe("ProviderAdapterSessionNotFoundError");
        const interrupt = yield* Effect.flip(adapter.interruptTurn(threadId));
        expect(interrupt._tag).toBe("ProviderAdapterSessionNotFoundError");
        // Questions/revert land with build items 9/10 — still typed stubs.
        const rollback = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
        expect(rollback._tag).toBe("ProviderAdapterRequestError");
        expect(rollback.message).toContain("not implemented");
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
      expect(cursors).toEqual([undefined, { sequence: 5, sortTimestamp: "t5" }]);
    }),
  );

  it.effect("fails loudly when a page claims more older rows without a cursor", () =>
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
              oldestSequenceLoaded: null,
              oldestSortTimestampLoaded: null,
              hasMoreOlder: true,
            }),
        },
      },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput({ resumeCursor: { schemaVersion: 1, taskId: "task-1", latestSequence: 6 } }),
          );
          const error = yield* Effect.flip(adapter.readThread(session.threadId));
          expect(error._tag).toBe("ProviderAdapterRequestError");
          expect(error.message).toContain("no older-page cursor");
        }),
    ),
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

  it.effect("resume onto an in-flight task adopts the turn and arms the settle backstop", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeAdapterSocket> = [];
      let deltaCalls = 0;
      let taskIdle = false;
      const restClient: AetherRestClient = {
        ...unusedRestClient,
        listProjects: () => Effect.succeed([project()]),
        getTask: () => Effect.succeed(processingTask),
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
  }): AetherConversationDelta => ({
    task: input.task,
    messages: input.messages ?? [],
    activity: [],
    activeProcessingTurn:
      input.activeMessageId !== undefined
        ? { messageId: input.activeMessageId, startedAt: "2026-08-08T10:02:00Z" }
        : null,
    latestSequence: input.latestSequence,
    removedMessageIds: [],
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
