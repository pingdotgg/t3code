import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Kompas from "./layers.ts";
import * as WorkstreamService from "./WorkstreamService.ts";
import { WorkstreamStore } from "./WorkstreamStore.ts";

const coordinator = ThreadId.make("coordinator");

const layer = (children: Array<ThreadId>) =>
  WorkstreamService.layer.pipe(
    Layer.provideMerge(Kompas.layerCore),
    Layer.provide(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        NodeCrypto.layer,
        Layer.mock(ServerSecretStore)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              subagents: children.map((childThreadId) => ({ origin: "app_owned", childThreadId })),
            } as never),
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        }),
      ),
    ),
  );

const project = (askBeforeStart: boolean) =>
  Effect.flatMap(WorkstreamStore, (store) =>
    store.create({
      title: "Trip",
      goal: "",
      instructions: "",
      threadModel: null,
      maxParallelThreads: 1,
      askBeforeStart,
      coordinatorThreadId: coordinator,
    }),
  );

it.effect("lets starts made together pass the limit only once", () => {
  const children: Array<ThreadId> = [];
  return Effect.gen(function* () {
    yield* project(false);
    const service = yield* WorkstreamService.WorkstreamService;
    const launching = yield* Deferred.make<void>();
    const launched = yield* Deferred.make<void>();
    const start = (name: string) =>
      service.startThread(
        coordinator,
        { title: name, task: name },
        Effect.gen(function* () {
          yield* Deferred.succeed(launching, undefined);
          yield* Deferred.await(launched);
          children.push(ThreadId.make(name));
          return name;
        }),
      );

    const first = yield* Effect.forkChild(start("first"));
    yield* Deferred.await(launching);
    const second = yield* Effect.forkChild(start("second"), { startImmediately: true });
    yield* Deferred.succeed(launched, undefined);

    assert.equal(yield* Fiber.join(first), "first");
    const refused = yield* Fiber.join(second).pipe(Effect.flip);
    assert.equal(refused.reason, "limit");
    assert.deepEqual(children, ["first"]);
  }).pipe(Effect.provide(layer(children)));
});

it.effect("starts only the approved thread, and keeps the approval when its launch fails", () =>
  Effect.gen(function* () {
    const workstream = yield* project(true);
    const store = yield* WorkstreamStore;
    const service = yield* WorkstreamService.WorkstreamService;
    const brief = { title: "Hotels", task: "Find hotels" };
    const start = (launch: Effect.Effect<string, string>, title = brief.title) =>
      service.startThread(coordinator, { ...brief, title }, launch);

    yield* start(Effect.succeed("started")).pipe(Effect.flip);
    yield* store.addGrant(workstream.id, brief);
    yield* start(Effect.succeed("started"), "Flights").pipe(Effect.flip);
    assert.equal(yield* start(Effect.fail("offline")).pipe(Effect.flip), "offline");
    assert.equal(yield* start(Effect.succeed("started")), "started");
    yield* start(Effect.succeed("again")).pipe(Effect.flip);
  }).pipe(Effect.provide(layer([]))),
);

it.effect("leaves threads outside projects alone", () =>
  Effect.gen(function* () {
    const service = yield* WorkstreamService.WorkstreamService;
    const started = yield* service.startThread(
      ThreadId.make("chat"),
      { title: "", task: "Anything" },
      Effect.succeed("started"),
    );
    assert.equal(started, "started");
  }).pipe(Effect.provide(layer([]))),
);
