import { Worker } from "alchemy/Cloudflare";
import {
  makeWorkerRuntimeContext,
  type WorkerRuntimeContext,
} from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import SqlMigrationsUnitObject, { implementation } from "./object.ts";

const WorkerHost = Context.Service<Worker, WorkerRuntimeContext>(
  Worker.Self.key,
);

await Effect.runPromise(
  Effect.gen(function* () {
    const worker = makeWorkerRuntimeContext("node-sql-migrations-unit");
    const construct = yield* implementation.pipe(
      Effect.provideService(WorkerHost, worker),
    );
    const instance = yield* construct;
    const snapshot = yield* instance.captured();
    const { default: _default, ...exports } = yield* worker.exports;
    yield* Effect.sync(() =>
      console.log(
        JSON.stringify({
          runtime: process.release.name,
          object: SqlMigrationsUnitObject.name,
          snapshot,
          capturedHasApply: typeof snapshot.apply === "function",
          exportedHasApply: Object.values(exports).some(
            (exported) =>
              exported.kind === "sqlMigrations" && "apply" in exported.snapshot,
          ),
          exports: Object.keys(exports).length,
          env: worker.env,
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
