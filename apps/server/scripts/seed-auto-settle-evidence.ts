import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApplicationProjectCreatedEvent,
  CommandId,
  EventId,
  OrchestrationV2DomainEvent,
  ProjectId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import fixture from "./auto-settle-evidence.fixture.json" with { type: "json" };

// Run with the isolated worktree server stopped. The event sink records history
// and updates projections together; timestamps model an inactive thread.
const databaseArg = process.argv[2];
const decodeProjectCreated = Schema.decodeEffect(ApplicationProjectCreatedEvent);
const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);
const anchorArg = process.argv[3];
const parsedAnchor =
  anchorArg === undefined
    ? undefined
    : Option.getOrThrowWith(
        DateTime.make(anchorArg),
        () => new Error("Expected ISO anchor timestamp"),
      );
const seed = Effect.fn("seedAutoSettleEvidence")(function* (databasePath: string) {
  const anchor = parsedAnchor ?? (yield* DateTime.now);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const projectId = ProjectId.make(fixture.project.projectId);
  const projectExists =
    yield* sql`SELECT 1 FROM projection_projects WHERE project_id = ${projectId}`;
  if (!projectExists.length) {
    const workspaceRoot = path.join(path.dirname(path.dirname(databasePath)), "evidence-workspace");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    const occurredAt = DateTime.formatIso(anchor);
    const commandId = CommandId.make("evidence:project:create");
    const { sequence: _, ...event } = yield* decodeProjectCreated({
      sequence: 0,
      eventId: "evidence:project:created",
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt,
      commandId,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        ...fixture.project,
        workspaceRoot,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    });
    yield* sink.commitProjectCommand({
      commandId,
      projectId,
      commandType: "project.create",
      acceptedAt: anchor,
      event,
    });
  }
  for (const { suffix, ageDays } of fixture.cases) {
    const id = `evidence:auto-settle:${suffix}`;
    const existing =
      yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${id}`;
    if (existing.length) continue;
    const at = DateTime.subtract(anchor, { days: ageDays });
    const event = yield* decodeDomainEvent({
      id: EventId.make(`evidence:created:${suffix}`),
      type: "thread.created",
      threadId: id,
      providerInstanceId: fixture.thread.providerInstanceId,
      occurredAt: at,
      payload: {
        ...fixture.thread,
        projectId,
        id,
        title: `Settlement evidence ${suffix}`,
        createdAt: at,
        updatedAt: at,
        lastVisitedAt: null,
        settledAt: null,
        settledOverride: null,
        archivedAt: null,
        deletedAt: null,
        snoozedAt: null,
        snoozedUntil: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      },
    });
    const events = yield* sink.write({ events: [event] });
    yield* Console.log(
      `${id} at ${DateTime.formatIso(at)}: ${events.map((stored) => stored.sequence).join(",")}`,
    );
  }
});
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // SQLite follows symlinks, so compare real paths. Missing tails resolve
    // through their nearest existing ancestor and are created as plain entries;
    // a dangling symlink has no real path but SQLite would still create its target.
    const realPathOf: (target: string) => Effect.Effect<string | undefined> = Effect.fn(
      "seedAutoSettleEvidence.realPathOf",
    )(function* (target: string) {
      const real = yield* Effect.option(fs.realPath(target));
      if (Option.isSome(real)) return real.value;
      const parent = path.dirname(target);
      if (parent === target || Option.isSome(yield* Effect.option(fs.readLink(target))))
        return undefined;
      const realParent = yield* realPathOf(parent);
      return realParent && path.join(realParent, path.basename(target));
    });
    // Resolve the worktree but not .t3 itself: a .t3 link elsewhere is rejected.
    const worktree = yield* realPathOf(path.resolve(import.meta.dirname, "../../.."));
    const isolatedHome = worktree && path.join(worktree, ".t3");
    const databasePath = path.resolve(databaseArg ?? "");
    const isInside = (real: string | undefined) => {
      const relative = isolatedHome && real && path.relative(isolatedHome, real);
      return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    // Sidecar files are opened next to the database and could be planted links too.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (databaseArg === undefined || !isInside(yield* realPathOf(databasePath + suffix)))
        return yield* Effect.die(new Error(`Expected a database inside ${isolatedHome}`));
    }
    const database = Sqlite.layerFromPath(databasePath);
    const stores = Layer.mergeAll(
      database,
      EventStore.layer.pipe(Layer.provide(database)),
      ProjectionStore.layer.pipe(Layer.provide(database)),
    );
    const services = Layer.mergeAll(stores, EventSink.layer.pipe(Layer.provide(stores)));
    yield* seed(databasePath).pipe(Effect.provide(services));
  }).pipe(Effect.provide(NodeServices.layer)),
);
