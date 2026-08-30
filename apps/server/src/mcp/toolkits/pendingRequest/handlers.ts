import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { PendingRequestMcpService } from "../../PendingRequestMcpService.ts";
import { PendingRequestToolkit } from "./tools.ts";

const handlers = {
  t3_pending_request_list: (input) =>
    PendingRequestMcpService.use((service) =>
      McpInvocationContext.use((scope) => service.list(scope, input)),
    ),
  t3_pending_request_read: (input) =>
    PendingRequestMcpService.use((service) =>
      McpInvocationContext.use((scope) => service.read(scope, input)),
    ),
  t3_pending_request_respond: (input) =>
    PendingRequestMcpService.use((service) =>
      McpInvocationContext.use((scope) => service.respond(scope, input)),
    ),
} satisfies Parameters<typeof PendingRequestToolkit.toLayer>[0];

export const PendingRequestToolkitHandlersLive = PendingRequestToolkit.toLayer(handlers);
