import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as Framework from "./Framework.ts";
import * as Server from "./Server.ts";

export { Cwd } from "./Cwd.ts";

/**
 * Effect's default logger minus annotations: framework child output carries an
 * `alchemy.stream` annotation that would otherwise trail every line.
 */
const logger = Logger.make<unknown, void>(({ message, logLevel, cause, date }) => {
  const parts = Array.isArray(message) ? message : [message];
  const text = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  console.log(`[${date.toISOString().slice(11, 23)}] ${logLevel.toUpperCase()}: ${text}`);
  if (cause.reasons.length > 0) console.log(Cause.pretty(cause));
});

export const layer = Server.layer.pipe(
  Layer.provideMerge(Logger.layer([logger])),
  Layer.provideMerge(Framework.layer),
  Layer.provideMerge(
    ConfigProvider.layer(
      ConfigProvider.fromDotEnv().pipe(Effect.orElseSucceed(() => ConfigProvider.fromEnv())),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

export const runMain = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
  const scope = Scope.makeUnsafe();
  return NodeRuntime.runMain(effect.pipe(Scope.provide(scope)), {
    teardown: (exit, onExit) => {
      void Effect.runPromise(Scope.close(scope, exit)).then(() => {
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
