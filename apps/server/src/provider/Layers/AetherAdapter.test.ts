import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { GitStatusDetails } from "../../vcs/GitVcsDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { makeAetherAdapter, parseAetherResume, type AetherSessionGit } from "./AetherAdapter.ts";
import { AetherApiNotFoundError, type AetherRestClient } from "./aether/restClient.ts";
import type { AetherProject, AetherTask, AetherTimelineMessage } from "./aether/restSchemas.ts";

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

const gitWith = (
  status: GitStatusDetails,
  originUrl: string | null = "git@github.com:acme/aether.git",
): AetherSessionGit => ({
  statusDetails: () => Effect.succeed(status),
  readConfigValue: (_cwd, key) => Effect.succeed(key === "remote.origin.url" ? originUrl : null),
});

/** Every method defects — override exactly what a test expects to be called. */
const unusedRestClient: AetherRestClient = {
  createTask: () => Effect.die("createTask must not be called"),
  respondToTask: () => Effect.die("respondToTask must not be called"),
  stopTask: () => Effect.die("stopTask must not be called — stop is a pure disconnect"),
  removeFromQueue: () => Effect.die("removeFromQueue must not be called"),
  updateTask: () => Effect.die("updateTask must not be called"),
  getTask: () => Effect.die("getTask must not be called"),
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
  },
  use: (adapter: ProviderAdapterShape<ProviderAdapterError>) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const adapter = yield* makeAetherAdapter({
      instanceId,
      defaultCwd: "/default-cwd",
      git: options.git ?? gitWith(cleanStatus),
      restClient:
        options.hasRestClient === false ? undefined : (options.restClient ?? unusedRestClient),
    });
    return yield* use(adapter);
  }).pipe(Effect.scoped, Effect.provideService(Crypto.Crypto, testCrypto));

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

  it.effect("turn-surface methods stay loud typed not-implemented stubs", () =>
    withAdapter({}, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-1");
        const sendTurn = yield* Effect.flip(adapter.sendTurn({ threadId, input: "hi" }));
        expect(sendTurn._tag).toBe("ProviderAdapterRequestError");
        expect(sendTurn.message).toContain("not implemented");
        const interrupt = yield* Effect.flip(adapter.interruptTurn(threadId));
        expect(interrupt._tag).toBe("ProviderAdapterRequestError");
        const rollback = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
        expect(rollback._tag).toBe("ProviderAdapterRequestError");
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
