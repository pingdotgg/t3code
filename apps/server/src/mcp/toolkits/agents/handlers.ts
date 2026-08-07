import * as Effect from "effect/Effect";

import * as AgentOrchestration from "../../../agents/AgentOrchestration.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentToolkit } from "./tools.ts";

const invoke = Effect.fn("AgentToolkit.invoke")(function* <A>(
  operation: (
    service: AgentOrchestration.AgentOrchestration["Service"],
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<A, AgentOrchestration.AgentOrchestrationError>,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("agents");
  const service = yield* AgentOrchestration.AgentOrchestration;
  return yield* operation(service, scope);
});

const handlers = {
  agent_list: (input) => invoke((service, scope) => service.list(scope, input)),
  agent_spawn: (input) => invoke((service, scope) => service.spawn(scope, input)),
  agent_status: (input) => invoke((service, scope) => service.status(scope, input)),
  agent_wait: (input) => invoke((service, scope) => service.wait(scope, input)),
  agent_result: (input) => invoke((service, scope) => service.result(scope, input)),
  agent_send: (input) => invoke((service, scope) => service.send(scope, input)),
  agent_cancel: (input) => invoke((service, scope) => service.cancel(scope, input)),
  agent_integrate: (input) => invoke((service, scope) => service.integrate(scope, input)),
} satisfies Parameters<typeof AgentToolkit.toLayer>[0];

export const AgentToolkitHandlersLive = AgentToolkit.toLayer(handlers);
