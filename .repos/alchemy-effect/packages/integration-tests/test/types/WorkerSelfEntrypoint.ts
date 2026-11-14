import * as Cloudflare from "@alchemy.run/cloudflare";
import type { McpEntrypoint } from "./WorkerSelfEntrypointModule.ts";

// The entrypoint class extends `WorkerEntrypoint<WorkerEnv>`, and `WorkerEnv`
// is derived from this Worker. Binding the class's instance type therefore
// needs `WorkerEnv` to be an interface: a type alias is resolved eagerly and
// TypeScript reports it as circular. Untyped `WorkerEntrypoint(name)`
// works with either.
export const Worker = Cloudflare.Worker("SelfEntrypointTypeProbe", {
  main: "./WorkerSelfEntrypointModule.ts",
  env: {
    MCP: Cloudflare.WorkerEntrypoint<McpEntrypoint>("McpEntrypoint"),
  },
});

export interface WorkerEnv extends Cloudflare.InferEnv<typeof Worker> {}

declare const env: WorkerEnv;
export const _tools: Promise<string[]> = env.MCP.tools();
// @ts-expect-error Unknown methods are not exposed.
env.MCP.missing();
