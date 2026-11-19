import { OrchestratorMcpFailure, type ProjectKnowledgeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectKnowledge from "../../../project/knowledge/ProjectKnowledge.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { KnowledgeToolkit } from "./tools.ts";

const failure = (error: ProjectKnowledgeError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });
// The service records a thread agent's reads, so recall does not send it those facts again.
const threadAccess = Effect.all({
  service: ProjectKnowledge.ProjectKnowledge,
  viewer: Effect.map(McpInvocationContext.McpInvocationContext, (scope) => scope.thread?.threadId),
});
export const layer = McpToolAccess.toLayer(KnowledgeToolkit, {
  t3_knowledge_search: McpToolAccess.withinProject(
    (input) => input.projectId,
    McpToolAccess.reads((input) =>
      Effect.flatMap(threadAccess, ({ service, viewer }) => service.search(input, viewer)).pipe(
        Effect.mapError(failure),
      ),
    ),
  ),
  t3_knowledge_list: McpToolAccess.withinProject(
    (input) => input.projectId,
    McpToolAccess.reads((input) =>
      Effect.flatMap(threadAccess, ({ service, viewer }) => service.list(input, viewer)).pipe(
        Effect.mapError(failure),
      ),
    ),
  ),
  t3_knowledge_read_fact: McpToolAccess.withinProject(
    (input) => input.projectId,
    McpToolAccess.reads((input) =>
      Effect.flatMap(threadAccess, ({ service, viewer }) => service.readFact(input, viewer)).pipe(
        Effect.mapError(failure),
      ),
    ),
  ),
  t3_knowledge_status: McpToolAccess.withinProject(
    (input) => input.projectId,
    McpToolAccess.reads((input) =>
      Effect.flatMap(ProjectKnowledge.ProjectKnowledge, (service) => service.status(input)).pipe(
        Effect.mapError(failure),
      ),
    ),
  ),
  t3_knowledge_read_source: McpToolAccess.withinProject(
    (input) => input.projectId,
    McpToolAccess.reads((input) =>
      Effect.flatMap(ProjectKnowledge.ProjectKnowledge, (service) =>
        service.readSource(input),
      ).pipe(Effect.mapError(failure)),
    ),
  ),
  t3_knowledge_prepare_context: McpToolAccess.withinProject(
    (input) => input.projectId,
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ProjectKnowledge.ProjectKnowledge;
        // The router consumes the target; attachments belong to the environment that serves them.
        return yield* service.prepareContext({ ...input, environmentId: scope.environmentId });
      }).pipe(Effect.mapError(failure)),
    ),
  ),
  t3_knowledge_mutate: McpToolAccess.withinProject(
    (input) => input.mutation.projectId,
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ProjectKnowledge.ProjectKnowledge;
        if (scope.thread !== undefined) {
          return yield* service
            .mutateWithHints(input.mutation, {
              kind: "agent-thread",
              threadId: scope.thread.threadId,
              providerInstanceId: scope.thread.providerInstanceId,
            })
            .pipe(Effect.mapError(failure));
        }
        if (scope.client !== undefined) {
          return yield* service
            .mutateWithHints(input.mutation, {
              kind: "agent-client",
              sessionId: scope.client.sessionId,
              label: scope.client.label,
            })
            .pipe(Effect.mapError(failure));
        }
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Knowledge observations require an authenticated agent caller.",
        });
      }),
    ),
  ),
});
