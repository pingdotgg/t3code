// Long-running driver for the hmr dev mode, spawned by test/hmr.test.ts:
// starts `next dev` (Turbopack) with proxied Cloudflare bindings via the
// Framework service and prints `DEV_URL <url>` when ready. Runs until
// SIGTERM/SIGINT, then closes the scope (stopping Next, the http server,
// and the binding proxy) and exits.
//
// The spec runs the server in a child process on purpose: `next dev`
// installs its own require hooks, which collide with playwright's in-worker
// transform (`Cannot read properties of undefined (reading '.js')`) — and a
// child process is also how the dev server runs in real life.
import { Text } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { Framework } from "@alchemy.run/frontend-frameworks/core";
import nextjsFramework from "@alchemy.run/frontend-frameworks/nextjs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const layer = nextjsFramework({
  root,
  dev: { mode: "hmr" },
  vite: {
    compatibilityDate: "2026-05-12",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    worker: {
      name: "fixtures-nextjs-hmr",
      bindings: [Text.local("TEST_TEXT", "hello-from-binding")],
    },
  },
}).pipe(Layer.provideMerge(NodeServices.layer));

const runtime = ManagedRuntime.make(layer);
const scope = Scope.makeUnsafe();
const server = await runtime.runPromise(
  Framework.use((f) => f.dev({ root })).pipe(Scope.provide(scope)),
);
console.log(`DEV_URL ${server.url}`);

const shutdown = async () => {
  await runtime.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
  await runtime.dispose().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
