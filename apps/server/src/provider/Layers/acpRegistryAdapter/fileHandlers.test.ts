// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildFileHandlers, resolveAcpPath } from "./fileHandlers.ts";

describe("resolveAcpPath", () => {
  const cwd = NodePath.resolve("/tmp/t3-acp-session");

  it("resolves relative and in-root absolute paths inside the session cwd", () => {
    expect(resolveAcpPath(cwd, "src/index.ts")).toBe(NodePath.join(cwd, "src", "index.ts"));
    expect(resolveAcpPath(cwd, NodePath.join(cwd, "README.md"))).toBe(
      NodePath.join(cwd, "README.md"),
    );
  });

  it("rejects paths that escape the session cwd", () => {
    expect(() => resolveAcpPath(cwd, "../outside.txt")).toThrow("inside the session cwd");
    expect(() => resolveAcpPath(cwd, NodePath.resolve(cwd, "..", "outside.txt"))).toThrow(
      "inside the session cwd",
    );
  });

  it.effect("returns a stable protocol error for a path traversal request", () => {
    const handlers = buildFileHandlers({ fileSystem: {} as never, cwd });
    return Effect.gen(function* () {
      const error = yield* handlers
        .onReadTextFile({ sessionId: "session-1", path: "../outside.txt" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: "File path must stay inside the session cwd: ../outside.txt",
        data: { operation: "resolve-file-path", path: "../outside.txt" },
        method: "fs/read_text_file",
        operation: "handle-request",
      });
    });
  });
});
