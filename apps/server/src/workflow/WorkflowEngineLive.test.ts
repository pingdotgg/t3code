import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MigrationsLive } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeStubStepExecutor } from "./Layers/StubStepExecutor.ts";
import { BoardRegistry } from "./Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "./Services/ScriptCancelRegistry.ts";
import { WorkflowEngine } from "./Services/WorkflowEngine.ts";
import { WorkflowReadModel } from "./Services/WorkflowReadModel.ts";
import { WorkflowEngineCoreLive } from "./WorkflowEngineLive.ts";

const definition = {
  name: "wf",
  lanes: [{ key: "backlog", name: "Backlog", entry: "manual" }],
};

let cryptoByte = 0;
const TestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => {
      const bytes = new Uint8Array(size);
      bytes.fill(cryptoByte);
      cryptoByte = (cryptoByte + 1) % 256;
      return bytes;
    },
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const layer = it.layer(
  WorkflowEngineCoreLive.pipe(
    Layer.provideMerge(makeStubStepExecutor({ default: { _tag: "completed" } })),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(TestCrypto),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowEngineCoreLive", (it) => {
  it.effect("composes the engine core with an injected StepExecutor", () =>
    Effect.gen(function* () {
      cryptoByte = 0;
      const registry = yield* BoardRegistry;
      yield* registry.register("b-live" as never, definition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const ticketId = yield* engine.createTicket({
        boardId: "b-live" as never,
        title: "Live layer",
        initialLane: "backlog" as never,
      });
      const detail = yield* read.getTicketDetail(ticketId);

      assert.equal(detail?.ticket.title, "Live layer");
      assert.equal(detail?.ticket.currentLaneKey, "backlog");
    }),
  );
});
