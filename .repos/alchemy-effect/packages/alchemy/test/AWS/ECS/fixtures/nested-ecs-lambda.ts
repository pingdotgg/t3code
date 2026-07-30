import * as ECS from "@/AWS/ECS";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "nested-ecs-lambda.ts");

// A nested Platform (ECS.Task) yielded DIRECTLY inside the Lambda's init
// program — the shape that used to OOM the Lambda sandbox at init (the ECS
// Bindings handler avoids it with `Resource.ref`). This exercises the
// nested-Platform ConfigProvider interceptor path in Platform.ts: the outer
// Lambda's intercepting ConfigProvider is the ambient provider while the
// nested Task's layer builds, and the fix ensures the host `get` reads
// `process.env` directly instead of recursing back through the interceptor.
//
// Honest external form: a pre-built busybox image (mirrored into ECR), no
// Effect program — we only need the Task to deploy and the Lambda sandbox
// to boot.
const NestedOneShotTask = ECS.Task("NestedReproOneShotTask", {
  image: "busybox:stable",
  command: ["sh", "-c", "echo alchemy-nested-repro-oneshot"],
  cpu: 256,
  memory: 512,
  taskName: "alchemy-nested-repro-oneshot",
});

export class NestedEcsReproFunction extends Lambda.Function<Lambda.Function>()(
  "NestedEcsReproFunction",
) {}

export default NestedEcsReproFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
    memorySize: 512,
  },
  Effect.gen(function* () {
    // Yielding the ECS Task (a Platform) directly inside the Lambda init is
    // the exact nesting that OOMed the sandbox before the Platform.ts fix.
    const task = yield* NestedOneShotTask;
    const containerName = yield* task.containerName;

    return {
      fetch: Effect.gen(function* () {
        // If the sandbox init recursed/OOMed, this route would never serve.
        return yield* HttpServerResponse.json({
          ok: true,
          taskType: task.Type,
          containerName,
        });
      }),
    };
  }),
);
