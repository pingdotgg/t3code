import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { classifyThreadActionFailure } from "./threadActionFailure";

const failure = (error: unknown) => classifyThreadActionFailure(Cause.fail(error));

describe("classifyThreadActionFailure", () => {
  it("recognizes a thread the server has no projection for", () => {
    expect(failure(new Error("No orchestration projection exists for thread mcp:b101.")).kind).toBe(
      "missing",
    );
  });

  it("recognizes a deleted thread", () => {
    expect(failure(new Error("Thread abc is deleted.")).kind).toBe("missing");
  });

  it("recognizes an archived thread", () => {
    expect(failure(new Error("Thread abc is archived.")).kind).toBe("archived");
    expect(failure(new Error("Thread abc is already archived.")).kind).toBe("other");
  });

  it("prefers the dispatch error's detail over its message", () => {
    expect(
      failure({
        _tag: "OrchestrationV2DispatchCommandError",
        message: "Failed to dispatch orchestration V2 command",
        detail: "Thread abc is deleted.",
      }),
    ).toEqual({ kind: "missing", message: "Thread abc is deleted." });
  });

  it("keeps other reasons and tolerates errors without text", () => {
    expect(failure(new Error("The server database is busy."))).toEqual({
      kind: "other",
      message: "The server database is busy.",
    });
    expect(failure(new Error("  "))).toEqual({ kind: "other", message: null });
    expect(failure("plain")).toEqual({ kind: "other", message: null });
  });
});
