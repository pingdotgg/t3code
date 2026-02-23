import type {
  ProviderApprovalDecision,
  ProviderKind,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { it, assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";

import { runGit as runGitProcess } from "../../git/Process.ts";
import { CheckpointServiceLive } from "./CheckpointService.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointService } from "../Services/CheckpointService.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../../provider/Errors.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../../provider/Services/ProviderAdapter.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { CheckpointRepository } from "../../persistence/Services/Checkpoints.ts";
import { CheckpointRepositoryLive } from "../../persistence/Layers/Checkpoints.ts";
import { ProviderSessionRepositoryLive } from "../../persistence/Layers/ProviderSessions.ts";

const runGit = (cwd: string, args: readonly string[]) =>
  runGitProcess({
    operation: "CheckpointService.test.git",
    cwd,
    args,
  }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.provide(NodeServices.layer),
  );

const makeGitRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* runGit(cwd, ["init", "--initial-branch=main"]);
  yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
  yield* runGit(cwd, ["config", "user.name", "Test User"]);
  yield* fs.writeFileString(path.join(cwd, "README.md"), "v1\n");
  yield* runGit(cwd, ["add", "."]);
  yield* runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
});

class InMemoryProviderAdapter implements ProviderAdapterShape<ProviderAdapterError> {
  readonly provider = "codex" as const;

  private readThreadFailure: ProviderAdapterError | undefined;
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly snapshots = new Map<string, ProviderThreadSnapshot>();

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    turns: ReadonlyArray<ProviderThreadTurnSnapshot>,
  ) {
    this.addSession({
      sessionId,
      threadId: "thread-1",
      turns,
    });
  }

  addSession(input: {
    readonly sessionId: string;
    readonly threadId: string;
    readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
  }): void {
    const now = new Date().toISOString();
    this.sessions.set(input.sessionId, {
      sessionId: input.sessionId,
      provider: "codex",
      status: "ready",
      threadId: input.threadId,
      cwd: this.cwd,
      createdAt: now,
      updatedAt: now,
    });
    this.snapshots.set(input.sessionId, {
      threadId: input.threadId,
      turns: input.turns,
    });
  }

  setTurns(turns: ReadonlyArray<ProviderThreadTurnSnapshot>, sessionId = this.sessionId): void {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      return;
    }
    this.snapshots.set(sessionId, {
      threadId: snapshot.threadId,
      turns,
    });
  }

  getTurns(sessionId = this.sessionId): ReadonlyArray<ProviderThreadTurnSnapshot> {
    return this.snapshots.get(sessionId)?.turns ?? [];
  }

  setReadThreadFailure(error: ProviderAdapterError | undefined): void {
    this.readThreadFailure = error;
  }

  readonly startSession = (
    _input: ProviderSessionStartInput,
  ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: this.provider,
        operation: "startSession",
        issue: "not implemented in test adapter",
      }),
    );

  readonly sendTurn = (
    _input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: this.provider,
        operation: "sendTurn",
        issue: "not implemented in test adapter",
      }),
    );

  readonly interruptTurn = (
    _sessionId: string,
    _turnId?: string,
  ): Effect.Effect<void, ProviderAdapterError> => Effect.void;

  readonly respondToRequest = (
    _sessionId: string,
    _requestId: string,
    _decision: ProviderApprovalDecision,
  ): Effect.Effect<void, ProviderAdapterError> => Effect.void;

  readonly stopSession = (sessionId: string): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      this.sessions.delete(sessionId);
      this.snapshots.delete(sessionId);
    });

  readonly listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() => Array.from(this.sessions.values()));

  readonly hasSession = (sessionId: string): Effect.Effect<boolean> =>
    Effect.succeed(this.sessions.has(sessionId));

  readonly readThread = (
    sessionId: string,
  ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
    this.hasSession(sessionId).pipe(
      Effect.flatMap((hasSession) =>
        hasSession
          ? this.readThreadFailure
            ? Effect.fail(this.readThreadFailure)
            : (() => {
                const snapshot = this.snapshots.get(sessionId);
                if (!snapshot) {
                  return Effect.fail(
                    new ProviderAdapterSessionNotFoundError({
                      provider: this.provider,
                      sessionId,
                    }),
                  );
                }
                return Effect.succeed(snapshot);
              })()
          : Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: this.provider,
                sessionId,
              }),
            ),
      ),
    );

  readonly rollbackThread = (
    sessionId: string,
    numTurns: number,
  ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
    this.readThread(sessionId).pipe(
      Effect.flatMap((snapshot) => {
        if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > snapshot.turns.length) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: this.provider,
              operation: "rollbackThread",
              issue: "invalid rollback input",
            }),
          );
        }
        const next = {
          threadId: snapshot.threadId,
          turns: snapshot.turns.slice(0, snapshot.turns.length - numTurns),
        } satisfies ProviderThreadSnapshot;
        this.snapshots.set(sessionId, next);
        return Effect.succeed(next);
      }),
    );

  readonly stopAll = (): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      this.sessions.clear();
      this.snapshots.clear();
    });

  readonly streamEvents = Stream.empty;
}

function makeFixture(turns: ReadonlyArray<ProviderThreadTurnSnapshot>) {
  return Effect.gen(function* () {
    const cwd = yield* makeGitRepository;

    const sessionId = "sess-1";
    const adapter = new InMemoryProviderAdapter(sessionId, cwd, turns);

    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider: ProviderKind) =>
        provider === "codex"
          ? Effect.succeed(adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };

    const directoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRepositoryLive),
    );

    const dependencies = Layer.mergeAll(
      Layer.provide(CheckpointStoreLive, NodeServices.layer),
      CheckpointRepositoryLive,
      Layer.succeed(ProviderAdapterRegistry, registry),
      directoryLayer,
      NodeServices.layer,
    ).pipe(Layer.provide(SqlitePersistenceMemory));

    const layer = CheckpointServiceLive.pipe(Layer.provideMerge(dependencies));

    return {
      layer,
      adapter,
      sessionId,
      cwd,
    };
  });
}

it.effect("captures checkpoints, diffs refs, and reverts workspace + turns", () =>
  Effect.gen(function* () {
    const firstTurn: ProviderThreadTurnSnapshot = {
      id: "turn-1",
      items: [{ type: "userMessage", content: [{ type: "text", text: "first" }] }],
    };
    const secondTurn: ProviderThreadTurnSnapshot = {
      id: "turn-2",
      items: [{ type: "agentMessage", text: "second" }],
    };

    const fixture = yield* makeFixture([]);

    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const service = yield* CheckpointService;
      const directory = yield* ProviderSessionDirectory;

      yield* directory.upsert({
        sessionId: fixture.sessionId,
        provider: "codex",
        threadId: "thread-1",
      });

      yield* service.initializeForSession({
        providerSessionId: fixture.sessionId,
        cwd: fixture.cwd,
      });

      yield* fs.writeFileString(path.join(fixture.cwd, "README.md"), "v2\n");
      fixture.adapter.setTurns([firstTurn]);

      yield* service.captureCurrentTurn({
        providerSessionId: fixture.sessionId,
      });

      const listed = yield* service.listCheckpoints({ sessionId: fixture.sessionId });
      assert.equal(listed.checkpoints.length, 2);
      assert.equal(listed.checkpoints[1]?.id, "turn-1");
      assert.equal(listed.checkpoints[1]?.isCurrent, true);

      const diff = yield* service.getCheckpointDiff({
        sessionId: fixture.sessionId,
        fromTurnCount: 0,
        toTurnCount: 1,
      });
      assert.equal(diff.threadId, "thread-1");
      assert.equal(diff.diff.includes("diff --git a/README.md b/README.md"), true);
      assert.equal(diff.diff.includes("-v1"), true);
      assert.equal(diff.diff.includes("+v2"), true);

      yield* fs.writeFileString(path.join(fixture.cwd, "README.md"), "v3\n");
      fixture.adapter.setTurns([firstTurn, secondTurn]);

      yield* service.captureCurrentTurn({
        providerSessionId: fixture.sessionId,
      });

      const beforeRevert = yield* fs.readFileString(path.join(fixture.cwd, "README.md"));
      assert.equal(beforeRevert, "v3\n");

      const reverted = yield* service.revertToCheckpoint({
        sessionId: fixture.sessionId,
        turnCount: 1,
      });

      const afterRevert = yield* fs.readFileString(path.join(fixture.cwd, "README.md"));
      assert.equal(afterRevert, "v2\n");
      assert.equal(reverted.turnCount, 1);
      assert.equal(reverted.rolledBackTurns, 1);
      assert.equal(reverted.checkpoints.length, 2);
      assert.equal(reverted.checkpoints[1]?.id, "turn-1");
      assert.equal(reverted.checkpoints[1]?.isCurrent, true);
      assert.equal(fixture.adapter.getTurns().length, 1);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "CheckpointServiceLive reuses checkpoint history after session churn on the same thread",
  () =>
    Effect.gen(function* () {
      const firstTurn: ProviderThreadTurnSnapshot = {
        id: "turn-1",
        items: [{ type: "userMessage", content: [{ type: "text", text: "first" }] }],
      };
      const secondTurn: ProviderThreadTurnSnapshot = {
        id: "turn-2",
        items: [{ type: "agentMessage", text: "second" }],
      };

      const fixture = yield* makeFixture([]);

      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* CheckpointService;
        const directory = yield* ProviderSessionDirectory;

        yield* directory.upsert({
          sessionId: fixture.sessionId,
          provider: "codex",
          threadId: "thread-1",
        });
        yield* service.initializeForSession({
          providerSessionId: fixture.sessionId,
          cwd: fixture.cwd,
        });

        yield* fs.writeFileString(path.join(fixture.cwd, "README.md"), "v2\n");
        fixture.adapter.setTurns([firstTurn]);
        yield* service.captureCurrentTurn({
          providerSessionId: fixture.sessionId,
        });

        const resumedSessionId = "sess-2";
        fixture.adapter.addSession({
          sessionId: resumedSessionId,
          threadId: "thread-1",
          turns: [firstTurn, secondTurn],
        });
        yield* directory.upsert({
          sessionId: resumedSessionId,
          provider: "codex",
          threadId: "thread-1",
        });

        yield* fs.writeFileString(path.join(fixture.cwd, "README.md"), "v3\n");
        yield* service.captureCurrentTurn({
          providerSessionId: resumedSessionId,
        });

        const listed = yield* service.listCheckpoints({ sessionId: resumedSessionId });
        assert.equal(listed.threadId, "thread-1");
        assert.equal(listed.checkpoints.length, 3);
        assert.equal(listed.checkpoints[2]?.id, "turn-2");
        assert.equal(listed.checkpoints[2]?.isCurrent, true);

        const diff = yield* service.getCheckpointDiff({
          sessionId: resumedSessionId,
          fromTurnCount: 1,
          toTurnCount: 2,
        });
        assert.equal(diff.threadId, "thread-1");
        assert.equal(diff.diff.includes("-v2"), true);
        assert.equal(diff.diff.includes("+v3"), true);

        const reverted = yield* service.revertToCheckpoint({
          sessionId: resumedSessionId,
          turnCount: 1,
        });
        const afterRevert = yield* fs.readFileString(path.join(fixture.cwd, "README.md"));
        assert.equal(afterRevert, "v2\n");
        assert.equal(reverted.turnCount, 1);
        assert.equal(reverted.rolledBackTurns, 1);
        assert.equal(fixture.adapter.getTurns(resumedSessionId).length, 1);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "CheckpointServiceLive fails with CheckpointSessionNotFoundError for unknown sessions",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture([]);

      yield* Effect.gen(function* () {
        const service = yield* CheckpointService;
        const result = yield* service
          .listCheckpoints({
            sessionId: "missing",
          })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "CheckpointSessionNotFoundError");
        }
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "CheckpointServiceLive fails with CheckpointUnavailableError when a checkpoint ref is missing",
  () =>
    Effect.gen(function* () {
      const firstTurn: ProviderThreadTurnSnapshot = {
        id: "turn-1",
        items: [{ type: "userMessage", content: [{ type: "text", text: "first" }] }],
      };

      const fixture = yield* makeFixture([]);

      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* CheckpointService;
        const store = yield* CheckpointStore;
        const checkpointRepository = yield* CheckpointRepository;
        const directory = yield* ProviderSessionDirectory;

        yield* directory.upsert({
          sessionId: fixture.sessionId,
          provider: "codex",
          threadId: "thread-1",
        });

        yield* service.initializeForSession({
          providerSessionId: fixture.sessionId,
          cwd: fixture.cwd,
        });

        yield* fs.writeFileString(path.join(fixture.cwd, "README.md"), "v2\n");
        fixture.adapter.setTurns([firstTurn]);
        yield* service.captureCurrentTurn({
          providerSessionId: fixture.sessionId,
        });

        const checkpoint = yield* checkpointRepository.getCheckpoint({
          threadId: "thread-1",
          turnCount: 1,
        });
        if (checkpoint._tag !== "Some") {
          assert.fail("Expected turn-1 checkpoint row to exist.");
        }

        yield* store.deleteCheckpointRefs({
          cwd: fixture.cwd,
          checkpointRefs: [checkpoint.value.checkpointRef],
        });

        const result = yield* service
          .revertToCheckpoint({
            sessionId: fixture.sessionId,
            turnCount: 1,
          })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "CheckpointUnavailableError");
        }
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("CheckpointServiceLive initializes root checkpoints without requiring thread/read", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture([]);

    yield* Effect.gen(function* () {
      const service = yield* CheckpointService;
      const checkpointRepository = yield* CheckpointRepository;
      const directory = yield* ProviderSessionDirectory;

      yield* directory.upsert({
        sessionId: fixture.sessionId,
        provider: "codex",
        threadId: "thread-1",
      });
      fixture.adapter.setReadThreadFailure(
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "readThread",
          issue: "thread/read is temporarily unavailable",
        }),
      );

      yield* service.initializeForSession({
        providerSessionId: fixture.sessionId,
        cwd: fixture.cwd,
      });

      const root = yield* checkpointRepository.getCheckpoint({
        threadId: "thread-1",
        turnCount: 0,
      });
      assert.equal(root._tag, "Some");
      if (root._tag === "Some") {
        assert.equal(root.value.threadId, "thread-1");
      }
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
