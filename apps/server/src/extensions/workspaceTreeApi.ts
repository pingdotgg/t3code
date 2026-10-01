// @effect-diagnostics nodeBuiltinImport:off
import { AuthOrchestrationReadScope, ExtensionOperationError } from "@t3tools/contracts";
import { workspaceTreeApi, type WorkspaceTreeEntry } from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "workspace.tree", detail });
const inputSchema = Schema.Record(Schema.String, Schema.Never);
/** Reuses the native index once per snapshot; reads do not recursively scan directories per page. */
export function createWorkspaceTreeApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly entries: Pick<WorkspaceEntries["Service"], "list">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  return {
    providerId: "host.workspace-tree",
    definition: workspaceTreeApi.definition,
    requiresRootAuthority: true,
    invoke: () => Promise.reject(failure("Workspace tree has no methods.")),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "snapshot" || resumeCursor !== undefined)
        throw failure("Workspace tree snapshot does not support this stream or resume cursor.");
      try {
        Schema.decodeUnknownSync(inputSchema, { onExcessProperty: "error" })(input);
      } catch {
        throw failure("Invalid workspace tree snapshot request.");
      }
      const principal = metadata.principal;
      if (
        !principal ||
        principal.environmentId !== dependencies.environmentId ||
        !principal.scopes.includes(AuthOrchestrationReadScope) ||
        !metadata.assertAuthority
      )
        throw failure("Workspace tree read authority is unavailable.");
      const assertAuthority = metadata.assertAuthority;
      return (async function* (): AsyncGenerator<ApiStreamEvent> {
        const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect, { signal });
        signal.throwIfAborted();
        const scope = await run(resolve(context));
        const result = await run(
          dependencies.entries
            .list({ cwd: scope.cwd })
            .pipe(
              Effect.mapError(() =>
                failure("Workspace index is unavailable for the current project."),
              ),
            ),
        );
        if (result.entries.length > 25000)
          throw failure("Workspace index exceeds the snapshot bound.");
        let chunk: WorkspaceTreeEntry[] = [];
        let bytes = 1024;
        for (const entry of result.entries) {
          signal.throwIfAborted();
          const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
          if (entry.path.length > 32768 || size + 1024 > 64 * 1024)
            throw failure("Workspace index contains an entry exceeding frame bounds.");
          if (chunk.length === 200 || bytes + size > 64 * 1024) {
            await run(resolve(scope.context));
            await assertAuthority();
            signal.throwIfAborted();
            yield {
              type: "data",
              value: { kind: "chunk", entries: chunk, truncated: result.truncated },
            };
            chunk = [];
            bytes = 1024;
          }
          chunk.push(entry);
          bytes += size;
        }
        if (chunk.length) {
          await run(resolve(scope.context));
          await assertAuthority();
          signal.throwIfAborted();
          yield {
            type: "data",
            value: { kind: "chunk", entries: chunk, truncated: result.truncated },
          };
        }
        await run(resolve(scope.context));
        await assertAuthority();
        signal.throwIfAborted();
        yield {
          type: "data",
          value: {
            kind: "complete",
            entryCount: result.entries.length,
            truncated: result.truncated,
          },
        };
      })();
    },
  };
}
export const makeWorkspaceTreeApiProvider = Effect.fn("WorkspaceTreeApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createWorkspaceTreeApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    entries: yield* WorkspaceEntries,
  });
});
