import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { ChatComposer } from "./ChatComposer.tsx";

// Component specs for the composer, exercised through OpenTUI's real (headless)
// renderer under bun:test. They lock in the double-input fix (no <input> while the
// terminal holds focus) and the rename/filter/new surfaces.

const noop = () => {};

const base = {
  reply: "",
  draft: "",
  auxValue: "",
  placeholder: "Type a reply, Enter to send",
  projectName: "Acme",
  onReplyInput: noop,
  onDraftInput: noop,
  onAuxInput: noop,
} as const;

async function frameOf(node: React.ReactNode): Promise<string> {
  const t = await testRender(node, { width: 60, height: 8 });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

describe("ChatComposer", () => {
  it("Given compose mode without focus, when rendered, then it shows the static ^P hint (no input)", async () => {
    const frame = await frameOf(<ChatComposer {...base} mode="compose" inputFocused={false} />);
    expect(frame).toContain("^P to type a reply");
  });

  it("Given compose mode with focus, when rendered, then the ^P hint is gone (input is mounted)", async () => {
    const frame = await frameOf(<ChatComposer {...base} mode="compose" inputFocused />);
    expect(frame).not.toContain("^P to type a reply");
  });

  it("Given rename mode, when rendered, then it shows the rename label and hint", async () => {
    const frame = await frameOf(<ChatComposer {...base} mode="rename" auxValue="old title" inputFocused />);
    expect(frame).toContain("rename");
    expect(frame).toContain("Enter rename");
  });

  it("Given filter mode, when rendered, then it shows the find label and hint", async () => {
    const frame = await frameOf(<ChatComposer {...base} mode="filter" auxValue="log" inputFocused />);
    expect(frame).toContain("find");
    expect(frame).toContain("Enter keep");
  });

  it("Given new-thread mode, when rendered, then it shows the dialog and the chosen project", async () => {
    const frame = await frameOf(<ChatComposer {...base} mode="new" inputFocused />);
    expect(frame).toContain("new thread");
    expect(frame).toContain("Acme");
  });

  it("Given a focused reply input, when text is typed, then onInput drives the value (the onInput fix)", async () => {
    function Harness(): React.ReactNode {
      const [reply, setReply] = React.useState("");
      return (
        <ChatComposer {...base} mode="compose" reply={reply} inputFocused onReplyInput={setReply} />
      );
    }
    const t = await testRender(<Harness />, { width: 60, height: 8 });
    await t.renderOnce();
    await t.mockInput.typeText("hello");
    const frame = await t.waitForFrame((f) => f.includes("hello"));
    expect(frame).toContain("hello");
    t.renderer.destroy();
  });
});
