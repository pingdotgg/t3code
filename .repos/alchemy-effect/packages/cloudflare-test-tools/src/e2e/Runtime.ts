import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Framework from "./Framework.ts";
import * as Server from "./Server.ts";

export { Cwd } from "./Cwd.ts";

export const layer = Server.layer.pipe(
  Layer.provideMerge(Framework.layer),
  Layer.provideMerge(
    ConfigProvider.layer(
      ConfigProvider.fromDotEnv().pipe(
        Effect.orElseSucceed(() => ConfigProvider.fromEnv()),
      ),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

export const runMain = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
  const scope = Scope.makeUnsafe();
  return NodeRuntime.runMain(effect.pipe(Scope.provide(scope)), {
    teardown: (exit, onExit) => {
      Effect.runPromise(Scope.close(scope, exit)).then(() => {
        const code = exit._tag === "Success" ? 0 : 1;
        onExit(code);
        // `NodeRuntime.runMain` only force-exits on failure/signal; on success
        // it waits for the event loop to drain. The runtime layers can leave
        // lingering handles behind (e.g. `cloudflare-runtime`'s docker proxy
        // listener is started on a detached fiber with no finalizer, keeping
        // the loop alive forever after a successful `e2e build`). A CLI must
        // exit deterministically once its teardown has run.
        process.exit(code);
      });
    },
  });
};
