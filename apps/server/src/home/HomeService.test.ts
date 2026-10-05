import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HomeWatchEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HomeService from "./HomeService.ts";

const environmentId = EnvironmentId.make("hub");
const homeProjectId = ProjectId.make("home-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const makeHome = () => {
  // Sends to fail before one succeeds, to model a Home that cannot be woken yet.
  const sendFailures = { remaining: 0 };
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  // Threads with a running turn, to model a Home that is busy when it is replaced.
  const running = new Set<string>();
  const shell = (threadId: ThreadId) =>
    ({
      id: threadId,
      projectId: homeProjectId,
      modelSelection,
      deletedAt: null,
      archivedAt: null,
      activeRunId: running.has(threadId) ? "run" : null,
    }) as unknown as OrchestrationV2ThreadShell;
  // provideMerge, so a test reads the same settings Home writes.
  const layer = HomeService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(ServerConfig.ServerConfig, {
          mode: "desktop",
        } as ServerConfig.ServerConfig["Service"]),
        ServerSettings.layerTest(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          ensureHomeProject: Effect.succeed({ projectId: homeProjectId, workspaceRoot: "/home" }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.succeed({ threadId: input.threadId } as ThreadLaunch.ThreadLaunchResult);
          },
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shell(threadId)),
          sendToThread: (input) => {
            if (sendFailures.remaining > 0) {
              sendFailures.remaining -= 1;
              return Effect.fail(
                new ThreadManagement.ThreadManagementThreadArchivedError({
                  threadId: input.threadId,
                }),
              );
            }
            sent.push(input);
            return Effect.succeed({} as ThreadManagement.ThreadManagementSendResult);
          },
          dispatch: (command) => {
            dispatched.push(command);
            return Effect.succeed({} as never);
          },
        }),
      ),
    ),
  );
  return { layer, launched, sent, dispatched, sendFailures, running };
};

const event = (threadId: string, kind: HomeWatchEvent["kind"]): HomeWatchEvent => ({
  environmentId,
  threadId: ThreadId.make(threadId),
  title: `Thread ${threadId}`,
  kind,
});

it.effect("enables one full-access Home thread and grants only that thread", () => {
  const { layer, launched } = makeHome();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const first = yield* home.enable({ modelSelection });
    const second = yield* home.enable({ modelSelection });
    expect(second.threadId).toBe(first.threadId);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ runtimeMode: "full-access", projectId: homeProjectId });
    expect(yield* home.isHome(first.threadId)).toBe(true);
    expect(yield* home.isHome(ThreadId.make("other"))).toBe(false);
  }).pipe(Effect.provide(layer));
});

it.effect("turning Home off revokes its reach at once", () => {
  const { layer } = makeHome();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const { threadId } = yield* home.enable({ modelSelection });
    yield* home.updateWatches(threadId, (current) =>
      HomeService.addWatch(current, {
        environmentId,
        threadId: ThreadId.make("a"),
        reason: "requested",
      }),
    );
    yield* home.disable;
    expect(yield* home.isHome(threadId)).toBe(false);
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    expect(settings.home).toEqual({ threadId: null, watchAll: false, watches: [] });
  }).pipe(Effect.provide(layer));
});

it.effect("wakes Home only for watched threads and ends watches on settle", () => {
  const { layer, sent } = makeHome();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const { threadId } = yield* home.enable({ modelSelection });
    for (const id of ["watched", "ending"]) {
      yield* home.updateWatches(threadId, (current) =>
        HomeService.addWatch(current, {
          environmentId,
          threadId: ThreadId.make(id),
          reason: "launched",
        }),
      );
    }
    yield* home.report({
      events: [
        event("watched", "question"),
        event("unwatched", "completed"),
        event("ending", "ended"),
      ],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId, mode: "auto", createdBy: "system" });
    expect(sent[0]!.text).toContain("[Thread watched](t3-thread://v1/hub/watched)");
    expect(sent[0]!.text).not.toContain("unwatched");
    const after = yield* home.updateWatches(threadId, (current) => current);
    expect(after.watches.map((watch) => watch.threadId)).toEqual(["watched"]);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a watch that ends in a batch until the batch is delivered", () => {
  const { layer, sent, sendFailures } = makeHome();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const { threadId } = yield* home.enable({ modelSelection });
    yield* home.updateWatches(threadId, (current) =>
      HomeService.addWatch(current, {
        environmentId,
        threadId: ThreadId.make("done"),
        reason: "launched",
      }),
    );
    const batch = { events: [event("done", "completed"), event("done", "ended")] };
    sendFailures.remaining = 1;
    yield* home.report(batch).pipe(Effect.flip);
    expect((yield* home.updateWatches(threadId, (current) => current)).watches).toHaveLength(1);
    yield* home.report(batch);
    expect(sent).toHaveLength(1);
    expect((yield* home.updateWatches(threadId, (current) => current)).watches).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("a Home thread that a fresh start replaced cannot change watches", () => {
  const { layer } = makeHome();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const { threadId: old } = yield* home.enable({ modelSelection });
    yield* home.startFresh;
    const error = yield* home
      .updateWatches(old, (current) => ({ ...current, watchAll: true }))
      .pipe(Effect.flip);
    expect(error.message).toContain("no longer Home");
  }).pipe(Effect.provide(layer));
});

it.effect("turning Home off holds the old Home's queue, then stops its run", () => {
  const { layer, dispatched, running } = makeHome();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const { threadId: idle } = yield* home.enable({ modelSelection });
    yield* home.disable;
    expect(dispatched).toMatchObject([{ type: "queue.hold", threadId: idle }]);

    dispatched.length = 0;
    const { threadId: busy } = yield* home.enable({ modelSelection });
    running.add(busy);
    yield* home.disable;
    expect(dispatched).toMatchObject([
      { type: "queue.hold", threadId: busy },
      { type: "run.interrupt", threadId: busy },
    ]);
    // Each command needs its own id; a reused id would replay the hold's receipt.
    expect(dispatched[0]?.commandId).not.toBe(dispatched[1]?.commandId);
  }).pipe(Effect.provide(layer));
});

it.effect("watching everything never wakes Home for its own thread", () => {
  const { layer, sent } = makeHome();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const { threadId } = yield* home.enable({ modelSelection });
    yield* home.updateWatches(threadId, (current) => ({ ...current, watchAll: true }));
    yield* home.report({ events: [event(threadId, "completed")] });
    expect(sent).toHaveLength(0);
    yield* home.report({ events: [event("anything", "failed")] });
    expect(sent).toHaveLength(1);
  }).pipe(Effect.provide(layer));
});

it.effect("starting fresh moves the grant to a new thread and settles the old one", () => {
  const { layer, dispatched } = makeHome();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const first = yield* home.enable({ modelSelection });
    const fresh = yield* home.startFresh;
    expect(fresh.threadId).not.toBe(first.threadId);
    expect(yield* home.isHome(first.threadId)).toBe(false);
    expect(yield* home.isHome(fresh.threadId)).toBe(true);
    expect(dispatched).toMatchObject([
      { type: "queue.hold", threadId: first.threadId },
      { type: "thread.settle", threadId: first.threadId },
    ]);
  }).pipe(Effect.provide(layer));
});

it("keeps the launched reason when a thread is watched again", () => {
  const threadId = ThreadId.make("t");
  const launched = HomeService.addWatch(
    { threadId: null, watchAll: false, watches: [] },
    { environmentId, threadId, reason: "launched" },
  );
  expect(HomeService.addWatch(launched, { environmentId, threadId, reason: "requested" })).toBe(
    launched,
  );
});
