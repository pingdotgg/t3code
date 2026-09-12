import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NativeIndex from "./workspace/NativeWorkspaceSearchIndex.ts";
import { SearchRequest, SearchResponse } from "./workspace/workspaceSearchProtocol.ts";

const decodeSearchRequest = Schema.decodeUnknownEffect(SearchRequest);
const encodeSearchResponse = Schema.encodeSync(SearchResponse);

// All indexes share this process. Native locks can stall workspace searches,
// but never the server's WebSocket, HTTP, or provider event loops.
const indexes = new Map<
  number,
  { scope: Scope.Closeable; index: NativeIndex.WorkspaceSearchIndex["Service"] }
>();
const execute = Effect.fn("WorkspaceSearchWorker.execute")(function* (request: SearchRequest) {
  const { id, operation: input } = request;
  if (input.method === "initialize") {
    const scope = Scope.makeUnsafe();
    const index = yield* NativeIndex.make(input.cwd, input.variant).pipe(Scope.provide(scope));
    indexes.set(id, { scope, index });
    return null;
  }
  const entry = indexes.get(id);
  if (!entry) return yield* Effect.die(new Error("Workspace index has not initialized."));
  switch (input.method) {
    case "list":
      return yield* entry.index.list();
    case "search":
      return yield* entry.index.search(input.query, input.limit, input.kind, input.imageOnly);
    case "searchContents":
      return yield* entry.index.searchContents(input.input);
    case "refresh":
      yield* entry.index.refresh();
      return null;
    case "dispose":
      indexes.delete(id);
      yield* Scope.close(entry.scope, Exit.void);
      return null;
  }
});

process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  // The parent serializes requests, so a response belongs to the sole caller.
  void Effect.runPromiseExit(
    decodeSearchRequest(message).pipe(Effect.orDie, Effect.flatMap(execute)),
  ).then((exit) => {
    try {
      process.send?.(encodeSearchResponse(exit));
    } catch (cause) {
      process.send?.(encodeSearchResponse(Exit.die(cause)));
    }
  });
});
