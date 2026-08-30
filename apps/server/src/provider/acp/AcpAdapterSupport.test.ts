import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  mapAcpToAdapterError,
  selectAcpPermissionOptionId,
  unifiedDiffFromToolCallContent,
} from "./AcpAdapterSupport.ts";

function permissionRequest(
  options: ReadonlyArray<{ optionId: string; kind: string }>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-1" },
    options: options.map((option) => ({
      ...option,
      name: option.optionId,
    })),
  } as EffectAcpSchema.RequestPermissionRequest;
}

describe("AcpAdapterSupport", () => {
  it("resolves the agent-offered option id for each decision", () => {
    const request = permissionRequest([
      { optionId: "allow", kind: "allow_once" },
      { optionId: "allow-forever", kind: "allow_always" },
      { optionId: "deny", kind: "reject_once" },
    ]);

    expect(selectAcpPermissionOptionId(request, "accept")).toBe("allow");
    expect(selectAcpPermissionOptionId(request, "acceptForSession")).toBe("allow-forever");
    expect(selectAcpPermissionOptionId(request, "decline")).toBe("deny");
  });

  it("falls back to allow_once when the agent omits allow_always", () => {
    const request = permissionRequest([
      { optionId: "allow", kind: "allow_once" },
      { optionId: "deny", kind: "reject_once" },
    ]);

    expect(selectAcpPermissionOptionId(request, "acceptForSession")).toBe("allow");
  });

  it("returns undefined when no offered option matches", () => {
    const request = permissionRequest([{ optionId: "deny", kind: "reject_once" }]);

    expect(selectAcpPermissionOptionId(request, "accept")).toBeUndefined();
    expect(selectAcpPermissionOptionId(request, "acceptForSession")).toBeUndefined();
    expect(selectAcpPermissionOptionId(permissionRequest([]), "decline")).toBeUndefined();
  });

  it("ignores options whose ids are blank", () => {
    const request = permissionRequest([
      { optionId: "  ", kind: "allow_once" },
      { optionId: "deny", kind: "reject_once" },
    ]);

    expect(selectAcpPermissionOptionId(request, "accept")).toBeUndefined();
  });

  it("renders diff content entries as one whole-file unified diff per file", () => {
    const unifiedDiff = unifiedDiffFromToolCallContent([
      { type: "content", content: { type: "text", text: "noise" } },
      {
        type: "diff",
        path: "src/a.ts",
        oldText: "old line",
        newText: "new line one\nnew line two",
      },
      { type: "diff", path: "src/b.ts", oldText: null, newText: "created" },
    ]);

    expect(unifiedDiff).toBe(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,1 +1,2 @@",
        "-old line",
        "+new line one",
        "+new line two",
        "--- /dev/null",
        "+++ b/src/b.ts",
        "@@ -1,0 +1,1 @@",
        "+created",
      ].join("\n"),
    );
  });

  it("returns undefined when a tool call carries no diff content", () => {
    expect(unifiedDiffFromToolCallContent(undefined)).toBeUndefined();
    expect(unifiedDiffFromToolCallContent([])).toBeUndefined();
    expect(
      unifiedDiffFromToolCallContent([{ type: "content", content: { type: "text", text: "x" } }]),
    ).toBeUndefined();
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
