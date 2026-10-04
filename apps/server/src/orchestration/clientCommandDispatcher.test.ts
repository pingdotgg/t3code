import { CommandId, MessageId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";

import { CheckoutCoordinator } from "../git/CheckoutCoordinator.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "../git/Services/GitStatusBroadcaster.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { makeClientCommandDispatcher } from "./clientCommandDispatcher.ts";

it("locks only worktree creation, not the command queue, dispatch, or setup", async () => {
  const source = "/project";
  const target = "/worktrees/new";
  const events: string[] = [];
  let locked = false;
  const command: OrchestrationCommand = {
    type: "thread.turn.start",
    commandId: CommandId.make("bootstrap"),
    threadId: ThreadId.make("thread"),
    message: {
      messageId: MessageId.make("message"),
      role: "user",
      text: "hello",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      prepareWorktree: {
        projectCwd: source,
        baseBranch: "main",
        branch: "feature",
      },
      runSetupScript: true,
    },
    createdAt: "2026-09-05T00:00:00.000Z",
  };
  const coordinator: CheckoutCoordinator["Service"] = {
    tryWithCheckout: () => Effect.die("Unexpected automatic checkout reservation"),
    beginFinalization: () => Effect.die("Unexpected finalization"),
    endFinalization: () => Effect.die("Unexpected finalization"),
    isFinalizing: () => Effect.die("Unexpected finalization lookup"),
    withCheckout: (cwd, effect) =>
      Effect.gen(function* () {
        expect(cwd).toBe(source);
        expect(locked).toBe(false);
        locked = true;
        events.push("lock");
        return yield* effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              locked = false;
              events.push("unlock");
            }),
          ),
        );
      }),
    withCheckoutUnlessSameRoot: (_cwd, _comparisonPath, effect) => effect,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(CheckoutCoordinator, coordinator),
    Layer.mock(GitCore, {
      createWorktree: () =>
        Effect.sync(() => {
          expect(locked).toBe(true);
          events.push("create");
          return { worktree: { path: target, branch: "feature" } };
        }),
    }),
    Layer.mock(GitStatusBroadcaster, {
      refreshStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasOriginRemote: false,
          isDefaultBranch: false,
          branch: "feature",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        }),
    }),
    Layer.mock(OrchestrationEngineService, {
      dispatch: (dispatched) =>
        Effect.sync(() => {
          expect(locked).toBe(false);
          events.push(dispatched.type);
          return { sequence: 1 };
        }),
    }),
    Layer.mock(ProjectSetupScriptRunner, {
      runForThread: (input) =>
        Effect.sync(() => {
          expect(locked).toBe(false);
          expect(input.worktreePath).toBe(target);
          events.push("setup");
          return { status: "no-script" as const };
        }),
    }),
    Layer.succeed(ServerRuntimeStartup, {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: (effect) =>
        Effect.suspend(() => {
          expect(locked).toBe(false);
          events.push("queue");
          return effect;
        }),
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = makeClientCommandDispatcher({
        git: yield* GitCore,
        gitStatusBroadcaster: yield* GitStatusBroadcaster,
        orchestrationEngine: yield* OrchestrationEngineService,
        projectSetupScriptRunner: yield* ProjectSetupScriptRunner,
        startup: yield* ServerRuntimeStartup,
      });
      yield* dispatch(command);
    }).pipe(Effect.provide(layer)),
  );
  expect(events).toEqual([
    "queue",
    "lock",
    "create",
    "unlock",
    "thread.meta.update",
    "setup",
    "thread.turn.start",
  ]);
});
