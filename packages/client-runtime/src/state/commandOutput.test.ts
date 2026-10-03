import { describe, expect, it } from "vite-plus/test";

import { applyCommandOutputFrame, EMPTY_COMMAND_OUTPUT } from "./commandOutput.ts";

describe("applyCommandOutputFrame", () => {
  it("continues an escape and a redraw split across appends", () => {
    let view = applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, {
      kind: "replace",
      text: "install\n12%\u001b[3",
      truncated: false,
      running: true,
    });
    expect(view.output.text).toBe("install\n12%");
    view = applyCommandOutputFrame(view, {
      kind: "append",
      text: "2m\r100%\u001b[0m\n",
      truncated: false,
      running: true,
    });
    expect(view.output.text).toBe("install\n100%\n");
    expect(view.running).toBe(true);
  });

  it("starts over from the tail a reconnect sends, keeping only that", () => {
    const stale = applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, {
      kind: "replace",
      text: "line 1\n",
      truncated: false,
      running: true,
    });
    const resumed = applyCommandOutputFrame(stale, {
      kind: "replace",
      text: "line 7\nline 8\n",
      truncated: true,
      running: true,
    });
    expect(resumed.output.text).toBe("line 7\nline 8\n");
    expect(resumed.output.truncated).toBe(true);
  });

  it("marks the output final when the command settles", () => {
    const view = applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, {
      kind: "replace",
      text: "done\n",
      truncated: false,
      running: false,
    });
    expect(view).toEqual({
      output: { text: "done\n", truncated: false, pending: "" },
      running: false,
    });
  });
});
