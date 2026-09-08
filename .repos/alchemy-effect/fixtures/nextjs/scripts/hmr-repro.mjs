// Minimal manual runner for the hmr dev mode: invokes the Framework service
// directly (no playwright), starts `next dev` with proxied bindings, probes
// three routes, and exits. Useful for debugging test/hmr.test.ts failures.
// Run with: node scripts/hmr-repro.mjs
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
console.log("dev server:", server.url);
for (const path of ["/", "/hmr-probe", "/api/binding"]) {
  const res = await fetch(new URL(path, server.url));
  const body = await res.text();
  console.log(path, res.status, body.slice(0, 300).replace(/\n/g, " "));
}
await runtime.runPromise(Scope.close(scope, Exit.void));
await runtime.dispose();
process.exit(0);
