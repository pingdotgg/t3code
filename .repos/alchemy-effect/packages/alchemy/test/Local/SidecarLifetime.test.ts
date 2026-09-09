import { RpcProviderProxy } from "@/Local/RpcProviderProxy";
import { Stack, type StackSpec } from "@/Stack";
import * as Core from "@/Test/Core.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

/**
 * The process-wide sidecar HTTP server must outlive the test file whose
 * `get()` first built it. `toEffect` runs each file in that file's
 * `sharedScope`; if that Scope leaks into the spawner layer, the file's
 * afterAll reloads the Bun.serve fetch handler away and later files POST
 * "Welcome to Bun!" instead of a websocket URL.
 */

const options = {
  providers: Layer.empty,
  dev: true,
};

const COMMAND_LOCAL = import.meta.resolve(
  "../../src/Command/Local.ts",
  import.meta.url,
);

type StackShape = Omit<StackSpec, "output">;

const dummyStack = (name: string): StackShape => ({
  name,
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
});

const runAsFile = <A, E, R>(
  handle: NonNullable<ReturnType<typeof Core.makeSidecarHandle>>,
  stackName: string,
  body: Effect.Effect<A, E, R>,
) => {
  const sharedScope = Scope.makeUnsafe("sequential");
  return Core.toEffect(
    body.pipe(
      Effect.provideService(Stack, dummyStack(stackName)),
    ) as Core.TestEffect<A>,
    options,
    sharedScope,
    handle,
  ).pipe(Effect.ensuring(Scope.close(sharedScope, Exit.void)));
};

it.live(
  "sidecar POST still returns a ws URL after the first file's scope closes",
  () =>
    Effect.gen(function* () {
      const handle = Core.makeSidecarHandle(options);
      expect(handle).toBeDefined();
      if (handle === undefined) return;

      const spawn = (stackName: string) =>
        runAsFile(
          handle,
          stackName,
          Effect.gen(function* () {
            const proxy = yield* RpcProviderProxy;
            const provider = yield* proxy.get(COMMAND_LOCAL, "Command.Dev");
            expect(provider).toBeDefined();
          }),
        );

      yield* spawn("sidecar-lifetime-a");
      yield* spawn("sidecar-lifetime-b");
      yield* handle.close;
    }),
  { timeout: 60_000 },
);
