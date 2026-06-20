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
  interactionMode: "default",
  composerEpoch: 0,
  onReplyInput: noop,
  onReplySubmit: noop,
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

  it("Given build mode, then the prompt shows a build badge", async () => {
    const frame = await frameOf(<ChatComposer {...base} mode="compose" interactionMode="default" inputFocused />);
    expect(frame).toContain("build");
  });

  it("Given plan mode, then the prompt shows a plan badge", async () => {
    const frame = await frameOf(<ChatComposer {...base} mode="compose" interactionMode="plan" inputFocused />);
    expect(frame).toContain("plan");
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

  it("Given a focused multiline reply editor, when text is typed, then it renders the content", async () => {
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

  it("Given multiline clipboard text, when pasted, then every line is inserted (no single-line cap) without sending", async () => {
    let sent = 0;
    let captured = "";
    function Harness(): React.ReactNode {
      const [reply, setReply] = React.useState("");
      return (
        <ChatComposer
          {...base}
          mode="compose"
          reply={reply}
          inputFocused
          onReplyInput={(value) => {
            captured = value;
            setReply(value);
          }}
          onReplySubmit={() => {
            sent += 1;
          }}
        />
      );
    }
    const t = await testRender(<Harness />, { width: 60, height: 12 });
    await t.renderOnce();
    await t.mockInput.pasteBracketedText("line one\nline two\nline three");
    const frame = await t.waitForFrame((f) => f.includes("line three"));
    expect(frame).toContain("line one");
    expect(frame).toContain("line three");
    expect(captured).toBe("line one\nline two\nline three");
    expect(sent).toBe(0);
    t.renderer.destroy();
  });

  it("Given a reply, when plain Enter is pressed, then it submits (like the web composer)", async () => {
    let sent = 0;
    function Harness(): React.ReactNode {
      const [reply, setReply] = React.useState("");
      return (
        <ChatComposer
          {...base}
          mode="compose"
          reply={reply}
          inputFocused
          onReplyInput={setReply}
          onReplySubmit={() => {
            sent += 1;
          }}
        />
      );
    }
    const t = await testRender(<Harness />, { width: 60, height: 8 });
    await t.renderOnce();
    await t.mockInput.typeText("ship it");
    t.mockInput.pressEnter();
    await t.waitFor(() => sent > 0);
    expect(sent).toBe(1);
    t.renderer.destroy();
  });
});
