import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MemoryVaultService from "../../../memoryVaults/MemoryVaultService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const callerVault = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Memory vault tools");
  const vaults = yield* MemoryVaultService.MemoryVaultService;
  const vault = yield* vaults
    .vaultForThread(thread.threadId)
    .pipe(
      Effect.mapError(
        (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );
  return { threadId: thread.threadId, vault, vaults };
});

const asFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  continuum_memory_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const { vault, vaults } = yield* callerVault;
      const hits = yield* vaults.search(query, vault.vaultId).pipe(Effect.mapError(asFailure));
      return {
        vault: vault.name,
        hits: hits.map(({ path, heading, excerpt }) => ({ path, heading, excerpt })),
      };
    }),
  ),
  continuum_memory_read: McpToolAccess.readsAsCaller(({ path }) =>
    Effect.gen(function* () {
      const { vault, vaults } = yield* callerVault;
      const overview = yield* vaults.overview().pipe(Effect.mapError(asFailure));
      const files =
        overview.vaults
          .find((entry) => entry.id === vault.vaultId)
          ?.files.map((file) => file.path) ?? [];
      const content =
        path === undefined
          ? undefined
          : yield* vaults.readFile(vault.vaultId, path).pipe(Effect.mapError(asFailure));
      return {
        vault: vault.name,
        access: vault.access,
        files,
        ...(content === undefined ? {} : { content }),
      };
    }),
  ),
  continuum_memory_update: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, vaults } = yield* callerVault;
      const result = yield* vaults
        .agentUpdate({
          threadId,
          path: input.path,
          content: input.content,
          mode: input.mode,
          ...(input.section === undefined ? {} : { section: input.section }),
        })
        .pipe(Effect.mapError(asFailure));
      return {
        vault: result.vault,
        path: result.path,
        chars: result.chars,
        redactedSecrets: result.redacted,
      };
    }),
  ),
});
