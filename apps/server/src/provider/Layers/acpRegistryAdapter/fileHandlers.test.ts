// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAcpPath } from "./fileHandlers.ts";

describe("resolveAcpPath", () => {
  const cwd = path.resolve("/tmp/t3-acp-session");

  it("resolves relative and in-root absolute paths inside the session cwd", () => {
    expect(resolveAcpPath(cwd, "src/index.ts")).toBe(path.join(cwd, "src", "index.ts"));
    expect(resolveAcpPath(cwd, path.join(cwd, "README.md"))).toBe(path.join(cwd, "README.md"));
  });

  it("rejects paths that escape the session cwd", () => {
    expect(() => resolveAcpPath(cwd, "../outside.txt")).toThrow("inside the session cwd");
    expect(() => resolveAcpPath(cwd, path.resolve(cwd, "..", "outside.txt"))).toThrow(
      "inside the session cwd",
    );
  });
});
