import * as Effect from "effect/Effect";

import * as AgentctlSandboxes from "../../../agentctl/AgentctlSandboxes.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SandboxToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(SandboxToolkit, {
  t3_sandbox_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const sandboxes = yield* AgentctlSandboxes.AgentctlSandboxes;
      yield* sandboxes.startWatching;
      const snapshot = yield* sandboxes.refresh;
      return {
        available: snapshot.status === "available",
        error: snapshot.error,
        sandboxes: snapshot.sandboxes.map((sandbox) => ({
          name: sandbox.name,
          phase: sandbox.phase,
          action: sandbox.action,
          detail: sandbox.detail,
          environmentId: sandbox.environmentId,
          workingDirectory: sandbox.workingDirectory,
          manifestPath: sandbox.manifestPath,
        })),
        manifests: snapshot.status === "available" ? yield* sandboxes.listManifests : [],
      };
    }),
  ),
  t3_sandbox_start: McpToolAccess.writesEnvironment(({ name }) =>
    Effect.flatMap(AgentctlSandboxes.AgentctlSandboxes, (sandboxes) => sandboxes.start(name)),
  ),
  t3_sandbox_stop: McpToolAccess.writesEnvironment(({ name }) =>
    Effect.flatMap(AgentctlSandboxes.AgentctlSandboxes, (sandboxes) => sandboxes.stop(name)),
  ),
  t3_sandbox_create: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(AgentctlSandboxes.AgentctlSandboxes, (sandboxes) => sandboxes.create(input)),
  ),
  t3_sandbox_delete: McpToolAccess.writesEnvironment(({ name }) =>
    Effect.flatMap(AgentctlSandboxes.AgentctlSandboxes, (sandboxes) => sandboxes.remove(name)),
  ),
});
