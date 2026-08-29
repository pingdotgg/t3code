import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectMcpService } from "../../ProjectMcpService.ts";
import { ProjectToolkit } from "./tools.ts";

const handlers = {
  t3_project_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ProjectMcpService;
      return yield* service.list(scope, input);
    }),
  t3_project_read: ({ projectId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ProjectMcpService;
      return yield* service.read(scope, projectId);
    }),
  t3_project_create: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ProjectMcpService;
      return yield* service.create(scope, input);
    }),
  t3_project_update: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ProjectMcpService;
      return yield* service.update(scope, input);
    }),
  t3_project_delete: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ProjectMcpService;
      return yield* service.delete(scope, input);
    }),
} satisfies Parameters<typeof ProjectToolkit.toLayer>[0];

export const ProjectToolkitHandlersLive = ProjectToolkit.toLayer(handlers);
