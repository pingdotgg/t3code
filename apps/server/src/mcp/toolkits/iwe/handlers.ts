import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as IweService from "../../../iwe/IweService.ts";
import type { IweCore } from "../../../iwe/iweCore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { IweToolkit } from "./tools.ts";

const withWorkspace = Effect.fn("IweMcp.withWorkspace")(function* <A>(
  name: string,
  work: (core: IweCore, root: string, threadId: string) => Promise<A>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "IWE tools");
  const service = yield* IweService.IweService;
  const projectRoot = yield* IweService.threadProjectRoot(thread.threadId as ThreadId);
  return yield* service
    .run(name, async (core) => {
      const root = await core.workspaceForThread(thread.threadId, projectRoot);
      if (root === null)
        throw new Error(
          "This thread has no IWE workspace. Open one with Add project → Open IWE Workspace, or pick one in the IWE panel.",
        );
      return work(core, root, thread.threadId);
    })
    .pipe(
      Effect.mapError(
        (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );
});

const handlers = {
  continuum_iwe_find: McpToolAccess.readsAsCaller((input) =>
    withWorkspace("agentFind", async (core, root, threadId) => {
      const results = await core.search(
        root,
        input.query ?? "",
        input.mode ?? "both",
        Math.min(input.limit ?? 20, 100),
      );
      core.record(threadId, results.slice(0, 10), "searched", "agent");
      return { workspace: root, results };
    }),
  ),
  continuum_iwe_retrieve: McpToolAccess.readsAsCaller((input) =>
    withWorkspace("agentRetrieve", async (core, root, threadId) => {
      const markdown = await core.retrieveExpanded(root, input.keys, {
        references: input.references ?? 0,
        backlinks: input.backlinks ?? 0,
        children: input.children ?? 0,
        parents: input.parents ?? 0,
      });
      const titles = await Promise.all(
        input.keys.map((key) =>
          core
            .note(root, key)
            .then((note) => ({ key, title: note.title }))
            .catch(() => ({ key, title: key })),
        ),
      );
      core.record(threadId, titles, "read", "agent");
      return { workspace: root, markdown };
    }),
  ),
  continuum_iwe_write: McpToolAccess.actsAsCaller((input) =>
    withWorkspace("agentWrite", async (core, root, threadId) => {
      if (input.mode === "update") {
        if (!input.key) throw new Error("update needs the note's key.");
        const note = await core.save(root, input.key, input.content);
        core.record(threadId, [note], "updated", "agent");
        return {
          key: note.key,
          title: note.title,
          path: note.path,
          links: note.references.length,
          backlinks: note.referencedBy.length + note.includedBy.length,
        };
      }
      const note = await core.create(root, {
        ...(input.key ? { key: input.key } : {}),
        ...(input.title ? { title: input.title } : {}),
        content: input.content,
      });
      core.record(threadId, [note], "created", "agent");
      return { key: note.key, title: note.title, path: note.path };
    }),
  ),
  continuum_iwe_rename: McpToolAccess.actsAsCaller((input) =>
    withWorkspace("agentRename", async (core, root, threadId) => {
      const result = await core.rename(root, input.key, input.newKey);
      const note = await core.note(root, input.newKey);
      core.record(threadId, [note], "renamed", "agent");
      return result;
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof IweToolkit.tools>;

export const layer = McpToolAccess.toLayer(IweToolkit, handlers);
