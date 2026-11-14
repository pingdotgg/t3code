// Worker module for the `WorkerSelfEntrypoint.ts` type probe. It imports
// `WorkerEnv` back from the probe, reproducing the module ↔ stack type cycle
// every async Worker has.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { WorkerEnv } from "./WorkerSelfEntrypoint.ts";

export class McpEntrypoint extends WorkerEntrypoint<WorkerEnv> {
  async tools(): Promise<string[]> {
    return ["search"];
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const tools = await env.MCP.tools();
    const response = await env.MCP.fetch(request);
    return new Response(`${tools.join(",")} ${response.status}`);
  },
} satisfies ExportedHandler<WorkerEnv>;
