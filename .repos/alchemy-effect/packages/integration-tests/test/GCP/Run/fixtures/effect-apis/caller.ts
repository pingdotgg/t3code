import * as GCP from "@alchemy.run/gcp";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { TaskApi, TaskRpcs } from "./schema.ts";
import { ApiBackend, ApiSidecar, RpcBackend, RpcSidecar } from "./targets.ts";

/**
 * Public service that calls each target through a typed client: Effect
 * RPC and HttpApi, over a sidecar and over a private service.
 */
export default class EffectApiCaller extends GCP.Run.Service<EffectApiCaller>()(
  "EffectApiCaller",
  { main: import.meta.url, location: "us-central1", invokerIamDisabled: true },
  Effect.gen(function* () {
    const rpcSidecar = yield* GCP.Run.bindContainer(RpcSidecar, { schema: TaskRpcs });
    const apiSidecar = yield* GCP.Run.bindContainer(ApiSidecar, { api: TaskApi });
    const rpcService = yield* GCP.Run.InvokeService(RpcBackend, { schema: TaskRpcs });
    const apiService = yield* GCP.Run.InvokeService(ApiBackend, { api: TaskApi });

    const missingTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.map(() => "found"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );

    return {
      fetch: Effect.gen(function* () {
        // Each call reports its own failure, so a broken transport names itself.
        const report = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                failed: Cause.pretty(cause),
                detail: JSON.stringify(Cause.squash(cause)),
              }),
            ),
          );
        return yield* HttpServerResponse.json({
          rpcSidecar: yield* report(
            Effect.all({
              task: rpcSidecar.getTask({ id: "t1" }).pipe(Effect.map((task) => task.title)),
              missing: missingTag(rpcSidecar.getTask({ id: "nope" })),
              counts: rpcSidecar.countTasks({ to: 3 }).pipe(
                Stream.runCollect,
                Effect.map((counts) => [...counts]),
              ),
            }),
          ),
          apiSidecar: yield* report(
            Effect.all({
              task: apiSidecar.Tasks.getTask({ params: { id: "t1" } }).pipe(
                Effect.map((task) => task.title),
              ),
              missing: missingTag(apiSidecar.Tasks.getTask({ params: { id: "nope" } })),
            }),
          ),
          rpcService: yield* report(
            Effect.all({
              task: rpcService.getTask({ id: "t1" }).pipe(Effect.map((task) => task.title)),
              missing: missingTag(rpcService.getTask({ id: "nope" })),
              counts: rpcService.countTasks({ to: 3 }).pipe(
                Stream.runCollect,
                Effect.map((counts) => [...counts]),
              ),
            }),
          ),
          apiService: yield* report(
            Effect.all({
              task: apiService.Tasks.getTask({ params: { id: "t1" } }).pipe(
                Effect.map((task) => task.title),
              ),
              missing: missingTag(apiService.Tasks.getTask({ params: { id: "nope" } })),
            }),
          ),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(GCP.Run.InvokeServiceHttp)),
) {}
