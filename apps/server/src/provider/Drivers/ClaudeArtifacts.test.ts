import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { makeClaudeArtifactListTracker } from "./ClaudeArtifacts.ts";

const message = (value: object) => value as SDKMessage;
const init = (tools: string[]) => message({ type: "system", subtype: "init", tools });
const toolUse = (id: string, input: object) =>
  message({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Artifact", input }] },
  });
const toolResult = (id: string, content: unknown, isError = false) =>
  message({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
  });
const result = (isError = false, text = "DONE") =>
  message({ type: "result", subtype: "success", is_error: isError, result: text });

const PAGE_ONE = `1 artifacts, published by you:
- (mine) A — https://claude.ai/artifact/A
(More exist: pass \`page_token\` "tok2" with the same \`scope\` to list the next ones.)`;
const PAGE_TWO = `1 artifacts, published by you:
- (mine) B — https://claude.ai/artifact/B`;

describe("makeClaudeArtifactListTracker", () => {
  it("keeps only list results and asks for the next page when the model stops early", () => {
    const tracker = makeClaudeArtifactListTracker();
    expect(tracker.onMessage(init(["Artifact"]))._tag).toBe("continue");
    tracker.onMessage(toolUse("t1", { action: "list", scope: "all" }));
    tracker.onMessage(toolResult("t1", PAGE_ONE));
    // A call the hook denied, and its result, are never read as a page.
    tracker.onMessage(toolUse("t2", { action: "read", url: "https://claude.ai/artifact/A" }));
    tracker.onMessage(
      toolResult("t2", "1 artifacts, published by you:\n- (mine) X — https://claude.ai/artifact/X"),
    );
    expect(tracker.onMessage(result())).toEqual({ _tag: "followUp", pageToken: "tok2" });

    tracker.onMessage(toolUse("t3", { action: "list", page_token: "tok2" }));
    tracker.onMessage(toolResult("t3", [{ type: "text", text: PAGE_TWO }]));
    expect(tracker.onMessage(result())).toEqual({
      _tag: "done",
      result: { _tag: "pages", pages: [PAGE_ONE, PAGE_TWO] },
    });
  });

  it("fails instead of keeping a partial list when the next page never arrives", () => {
    const tracker = makeClaudeArtifactListTracker();
    tracker.onMessage(toolUse("t1", { action: "list" }));
    tracker.onMessage(toolResult("t1", PAGE_ONE));
    expect(tracker.onMessage(result())).toEqual({ _tag: "followUp", pageToken: "tok2" });
    tracker.onMessage(toolUse("t2", { action: "list", page_token: "tok2" }));
    tracker.onMessage(toolResult("t2", "Invalid page_token.", true));
    expect(tracker.onMessage(result())).toEqual({
      _tag: "done",
      result: { _tag: "failed", message: "Invalid page_token." },
    });
  });

  it("reports a signed-out account when Claude Code offers no Artifact tool", () => {
    const step = makeClaudeArtifactListTracker().onMessage(init(["Read"]));
    expect(step).toMatchObject({ _tag: "done", result: { _tag: "signedOut" } });
  });

  it("reports a login error as signed out and a tool error as a failure", () => {
    expect(
      makeClaudeArtifactListTracker().onMessage(result(true, "Not logged in · Please run /login")),
    ).toMatchObject({ _tag: "done", result: { _tag: "signedOut" } });

    const tracker = makeClaudeArtifactListTracker();
    tracker.onMessage(toolUse("t1", { action: "list" }));
    tracker.onMessage(toolResult("t1", "claude.ai is unavailable", true));
    expect(tracker.onMessage(result())).toEqual({
      _tag: "done",
      result: { _tag: "failed", message: "claude.ai is unavailable" },
    });
  });
});
