import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as KnowledgeMap from "../../../knowledgeMap.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { KnowledgeToolkit } from "./tools.ts";

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const handlers = {
  knowledge_map_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const entries = yield* (yield* KnowledgeMap.KnowledgeMap).list.pipe(
        Effect.mapError(toFailure),
      );
      return entries.map(({ threadId: _, ...entry }) => entry);
    }),
  ),
  knowledge_map_mark_done: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(
        scope,
        "knowledge_map_mark_done",
      );
      const entry = yield* (yield* KnowledgeMap.KnowledgeMap)
        .markDone({ ...input, threadId: thread.threadId })
        .pipe(Effect.mapError(toFailure));
      return { saved: entry.topic };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof KnowledgeToolkit.tools>;

export const layer = McpToolAccess.toLayer(KnowledgeToolkit, handlers);
