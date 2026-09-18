import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { ServerActivation } from "../serverActivation.ts";
import * as AutoContinueReactor from "./AutoContinueReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const DUE_AT = "2026-08-28T11:00:00.000Z";
const LATER_AT = "2026-08-28T14:00:00.000Z";
const PROJECT_ID = ProjectId.make("auto-continue-project");

type FireCommand = Extract<OrchestrationCommand, { readonly type: "thread.auto-continue.fire" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [],
    threads,
    updatedAt: NOW,
  };
}

const makeHarness = Effect.fn("makeAutoContinueHarness")(function* (
  snapshot: OrchestrationShellSnapshot,
) {
  const activation = yield* Deferred.make<void>();
  const snapshotReads = yield* Queue.unbounded<void>();
  const commands = yield* Ref.make<ReadonlyArray<FireCommand>>([]);

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () => Queue.offer(snapshotReads, undefined).pipe(Effect.as(snapshot)),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) => {
        if (command.type !== "thread.auto-continue.fire") {
          return Effect.die(new Error(`Unexpected command: ${command.type}`));
        }
        return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.as({ sequence: 1 }),
        );
      },
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  return {
    activation,
    snapshotReads,
    commands,
    layer: AutoContinueReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

describe("AutoContinueReactor", () => {
  it.effect("fires due continuations as thread.auto-continue.fire commands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness(
          makeSnapshot([makeThread("due-thread", { autoContinueAt: DUE_AT })]),
        );
        yield* Effect.provide(
          Effect.gen(function* () {
            const reactor = yield* AutoContinueReactor.AutoContinueReactor;
            yield* reactor.start();
            yield* Deferred.succeed(harness.activation, undefined);
            yield* Queue.take(harness.snapshotReads);
            yield* reactor.drain;
          }),
          harness.layer,
        );
        const dispatched = yield* Ref.get(harness.commands);
        assert.strictEqual(dispatched.length, 1);
        assert.strictEqual(dispatched[0]?.threadId, "due-thread");
        assert.strictEqual(dispatched[0]?.autoContinueAt, DUE_AT);
        assert.isTrue(dispatched[0]?.commandId.startsWith("server:auto-continue:due-thread:"));
        assert.isString(dispatched[0]?.messageId);
      }),
    ),
  );

  it.effect("leaves future schedules, archived threads, and unscheduled threads alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness(
          makeSnapshot([
            makeThread("later-thread", { autoContinueAt: LATER_AT }),
            makeThread("archived-thread", { autoContinueAt: DUE_AT, archivedAt: NOW }),
            makeThread("plain-thread"),
          ]),
        );
        yield* Effect.provide(
          Effect.gen(function* () {
            const reactor = yield* AutoContinueReactor.AutoContinueReactor;
            yield* reactor.start();
            yield* Deferred.succeed(harness.activation, undefined);
            yield* Queue.take(harness.snapshotReads);
            yield* reactor.drain;
          }),
          harness.layer,
        );
        const dispatched = yield* Ref.get(harness.commands);
        assert.strictEqual(dispatched.length, 0);
      }),
    ),
  );
});
