import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { it, assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Queue, Stream } from "effect";

import { runGit as runGitProcess } from "../src/git/Process.ts";
import { CheckpointServiceLive } from "../src/checkpointing/Layers/CheckpointService.ts";
import { CheckpointStoreLive } from "../src/checkpointing/Layers/CheckpointStore.ts";
import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { CheckpointRepositoryLive } from "../src/persistence/Layers/Checkpoints.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
  type TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import {
  codexTurnApprovalFixture,
  codexTurnToolFixture,
  codexTurnTextFixture,
} from "./fixtures/providerRuntime.ts";

const runGit = (cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
  runGitProcess({
    operation: "providerService.integration.git",
    cwd,
    args,
    allowNonZeroExit,
  }).pipe(Effect.provide(NodeServices.layer));

const gitRefExists = (cwd: string, ref: string) =>
  runGit(cwd, ["show-ref", "--verify", "--quiet", ref], true).pipe(
    Effect.map((result) => result.code === 0),
  );

const checkpointRefForTurn = (threadId: string, turnCount: number) =>
  `refs/t3/checkpoints/${Buffer.from(threadId, "utf8").toString("base64url")}/turn/${turnCount}`;

const makeGitRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();

  yield* runGit(cwd, ["init", "--initial-branch=main"]);
  yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
  yield* runGit(cwd, ["config", "user.name", "Test User"]);
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  yield* runGit(cwd, ["add", "."]);
  yield* runGit(cwd, ["commit", "-m", "Initial"]);

  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

interface IntegrationFixture {
  readonly cwd: string;
  readonly harness: TestProviderAdapterHarness;
  readonly layer: Layer.Layer<ProviderService, unknown, never>;
}

const makeIntegrationFixture = Effect.gen(function* () {
  const cwd = yield* makeGitRepository;
  const harness = yield* makeTestProviderAdapterHarness;

  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(harness.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex"]),
  };

  const shared = Layer.mergeAll(
    ProviderSessionDirectoryLive,
    Layer.succeed(ProviderAdapterRegistry, registry),
    Layer.provide(CheckpointStoreLive, NodeServices.layer),
    Layer.provide(CheckpointRepositoryLive, SqlitePersistenceMemory),
  );

  const checkpointLayer = CheckpointServiceLive.pipe(Layer.provide(shared));

  const layer = ProviderServiceLive.pipe(
    Layer.provide(Layer.mergeAll(shared, checkpointLayer)),
    Layer.merge(NodeServices.layer),
  );

  return {
    cwd,
    harness,
    layer,
  } satisfies IntegrationFixture;
});

const collectEventsDuring = <A, E, R>(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(stream, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
      Effect.forkScoped,
    );

    yield* action;

    return yield* Effect.forEach(
      Array.from({ length: count }, () => undefined),
      () => Queue.take(queue),
      { discard: false },
    );
  });

const runTurn = (input: {
  readonly provider: ProviderServiceShape;
  readonly harness: TestProviderAdapterHarness;
  readonly sessionId: string;
  readonly userText: string;
  readonly response: TestTurnResponse;
}) =>
  Effect.gen(function* () {
    yield* input.harness.queueTurnResponse(input.sessionId, input.response);

    return yield* collectEventsDuring(
      input.provider.streamEvents,
      input.response.events.length + 1,
      input.provider.sendTurn({
        sessionId: input.sessionId,
        input: input.userText,
        attachments: [],
      }),
    );
  });

it.effect("replays typed runtime fixture and emits checkpoint.captured", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession({
        provider: "codex",
        cwd: fixture.cwd,
      });
      const threadId = session.threadId ?? "";
      assert.equal(threadId.length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        sessionId: session.sessionId,
        userText: "hello",
        response: { events: codexTurnTextFixture },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        [...codexTurnTextFixture.map((event) => event.type), "checkpoint.captured"],
      );

      const checkpoints = yield* provider.listCheckpoints({ sessionId: session.sessionId });
      assert.deepEqual(
        checkpoints.checkpoints.map((checkpoint) => checkpoint.turnCount),
        [0, 1],
      );

      const diff = yield* provider.getCheckpointDiff({
        sessionId: session.sessionId,
        fromTurnCount: 0,
        toTurnCount: 1,
      });
      assert.equal(diff.diff.trim(), "");

      const turnOneRefExists = yield* gitRefExists(fixture.cwd, checkpointRefForTurn(threadId, 1));
      assert.equal(turnOneRefExists, true);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("captures file-changing fixture turn and produces a non-empty diff", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture;
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession({
        provider: "codex",
        cwd: fixture.cwd,
      });
      const threadId = session.threadId ?? "";
      assert.equal(threadId.length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        sessionId: session.sessionId,
        userText: "make a small change",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        [...codexTurnToolFixture.map((event) => event.type), "checkpoint.captured"],
      );

      const diff = yield* provider.getCheckpointDiff({
        sessionId: session.sessionId,
        fromTurnCount: 0,
        toTurnCount: 1,
      });
      assert.equal(diff.diff.includes("README.md"), true);

      const turnOneRefExists = yield* gitRefExists(fixture.cwd, checkpointRefForTurn(threadId, 1));
      assert.equal(turnOneRefExists, true);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("runs multi-turn tool/approval flow with contiguous checkpoints", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture;
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession({
        provider: "codex",
        cwd: fixture.cwd,
      });
      const threadId = session.threadId ?? "";
      assert.equal(threadId.length > 0, true);

      const firstTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        sessionId: session.sessionId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        firstTurnEvents.map((event) => event.type),
        [...codexTurnToolFixture.map((event) => event.type), "checkpoint.captured"],
      );

      const secondTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        sessionId: session.sessionId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        secondTurnEvents.map((event) => event.type),
        [...codexTurnApprovalFixture.map((event) => event.type), "checkpoint.captured"],
      );

      const turnStateBeforeRevert = yield* provider.listCheckpoints({
        sessionId: session.sessionId,
      });
      assert.deepEqual(
        turnStateBeforeRevert.checkpoints.map((checkpoint) => checkpoint.turnCount),
        [0, 1, 2],
      );
      const current =
        turnStateBeforeRevert.checkpoints.find((checkpoint) => checkpoint.isCurrent) ??
        turnStateBeforeRevert.checkpoints[turnStateBeforeRevert.checkpoints.length - 1];
      assert.equal(current?.turnCount, 2);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reverts to turn 1 and prunes later checkpoint refs", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture;
    const { join } = yield* Path.Path;
    const { writeFileString, readFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession({
        provider: "codex",
        cwd: fixture.cwd,
      });
      const threadId = session.threadId ?? "";
      assert.equal(threadId.length > 0, true);

      yield* runTurn({
        provider,
        harness: fixture.harness,
        sessionId: session.sessionId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* runTurn({
        provider,
        harness: fixture.harness,
        sessionId: session.sessionId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      const turnTwoRef = checkpointRefForTurn(threadId, 2);
      const turnTwoRefBefore = yield* gitRefExists(fixture.cwd, turnTwoRef);
      assert.equal(turnTwoRefBefore, true);

      const revert = yield* provider.revertToCheckpoint({
        sessionId: session.sessionId,
        turnCount: 1,
      });
      assert.equal(revert.rolledBackTurns, 1);

      const rollbackCalls = fixture.harness.getRollbackCalls(session.sessionId);
      assert.deepEqual(rollbackCalls, [1]);

      const readme = yield* readFileString(join(fixture.cwd, "README.md"));
      assert.equal(readme, "v2\n");

      const afterRevertCheckpoints = yield* provider.listCheckpoints({
        sessionId: session.sessionId,
      });
      assert.deepEqual(
        afterRevertCheckpoints.checkpoints.map((checkpoint) => checkpoint.turnCount),
        [0, 1],
      );

      const turnTwoRefAfter = yield* gitRefExists(fixture.cwd, turnTwoRef);
      assert.equal(turnTwoRefAfter, false);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
