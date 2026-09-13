// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { SearchRequest, SearchResponse } from "../src/workspace/workspaceSearchProtocol.ts";
import {
  WorkspaceSearchIndexRefreshFailed,
  WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndexSearchFailed,
} from "../src/workspace/WorkspaceSearchIndexService.ts";

const decodeSearchRequest = Schema.decodeUnknownSync(SearchRequest);
const encodeSearchResponse = Schema.encodeSync(SearchResponse);

const directories = new Map<number, string>();
const block = () => {
  const socket = NodeNet.connect(
    Number(process.env.T3_SEARCH_TEST_RECEIPT_PORT),
    "127.0.0.1",
    () => {
      socket.write("blocked");
      // Model a synchronous FFI call which cannot service IPC or JS timers.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    },
  );
};
process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  const { id, operation: input } = decodeSearchRequest(message);
  if (input.method === "initialize") directories.set(id, input.cwd);
  const cwd = directories.get(id) ?? "";
  if (input.method === "dispose") {
    if (cwd === "block-dispose") {
      block();
      return;
    }
    directories.delete(id);
    process.send?.(encodeSearchResponse(Exit.succeed(null)));
    return;
  }
  if (cwd === "block-initialize" || (input.method === "search" && input.query === "block")) {
    block();
    return;
  }
  if (input.method === "search" && input.query === "crash") process.exit(1);
  if (input.method === "search" && input.query === "search-error") {
    process.send?.(
      encodeSearchResponse(
        Exit.fail(
          new WorkspaceSearchIndexSearchFailed({
            cwd,
            queryLength: input.query.length,
            pageSize: input.limit + 1,
            reason: "search rejected",
          }),
        ),
      ),
    );
    return;
  }
  if (input.method === "search" && input.query === "hold") {
    const socket = NodeNet.connect(
      Number(process.env.T3_SEARCH_TEST_RECEIPT_PORT),
      "127.0.0.1",
      () => socket.write("blocked"),
    );
    socket.once("data", () => {
      socket.end();
      process.send?.(
        encodeSearchResponse(
          Exit.succeed({
            entries: [{ path: String(process.pid), kind: "file" }],
            truncated: false,
          }),
        ),
      );
    });
    return;
  }
  if (input.method === "refresh") {
    process.send?.(
      encodeSearchResponse(
        Exit.fail(new WorkspaceSearchIndexRefreshFailed({ cwd, reason: "scan failed" })),
      ),
    );
    return;
  }
  if (cwd === "scan-timeout") {
    process.send?.(
      encodeSearchResponse(
        Exit.fail(new WorkspaceSearchIndexScanTimedOut({ cwd, timeout: "15 seconds" })),
      ),
    );
    return;
  }
  process.send?.(
    encodeSearchResponse(
      Exit.succeed(
        input.method === "initialize"
          ? null
          : {
              entries: [{ path: String(process.pid), kind: "file" }],
              truncated: false,
            },
      ),
    ),
  );
});
