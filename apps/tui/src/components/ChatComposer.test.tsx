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
  newRuntimeMode: "full-access",
  newModel: "gpt-5",
  newReasoning: "high",
  newBranch: null,
  newWorkspaceMode: "current",
  newWorkspaceLabel: "Project workspace",
  newBranchStatus: "empty",
  newField: "message",
  editorRows: 3,
  composerEpoch: 0,
  controls: {
    interactionMode: "default",
    runtimeMode: "full-access",
    model: "gpt-5",
    reasoning: "high",
  },
  working: false,
  attachments: [],
  inlineImagesSupported: false,
  width: 56,
  pendingUserInput: null,
  uiQuestionIndex: 0,
  uiOptionIndex: 0,
  uiSelectedLabels: [],
  answerDraft: "",
  onAnswerInput: noop,
  onReplyInput: noop,
  onReplySubmit: noop,
  onDraftInput: noop,
  onNewFieldActivate: noop,
  onAuxInput: noop,
  onTogglePlan: noop,
  onOpenAccess: noop,
  onOpenModel: noop,
  onOpenReasoning: noop,
  onStop: noop,
  onSend: noop,
  onSubmitAnswer: noop,
  onRemoveAttachment: noop,
} as const;

async function frameOf(node: React.ReactNode): Promise<string> {
  const t = await testRender(node, { width: 60, height: 12 });
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

  it("Given a pending question, then the composer stays put with the question panel + Submit answer", async () => {
    const pending = {
      requestId: "r1",
      createdAt: "2026-06-19T00:00:00.000Z",
      questions: [
        {
          id: "q1",
          header: "Scope",
          question: "Which scope should the plan target?",
          options: [
            { label: "Both", description: "" },
            { label: "Data only", description: "" },
          ],
          multiSelect: false,
        },
      ],
    } as never;
    const t = await testRender(
      <ChatComposer {...base} mode="compose" inputFocused pendingUserInput={pending} />,
      { width: 80, height: 12 },
    );
    await t.renderOnce();
    await t.flush();
    const frame = t.captureCharFrame();
    // Question panel + custom-answer field + the Submit-answer primary action,
    // all inside the still-present composer (with its model footer).
    expect(frame).toContain("Which scope should the plan target?");
    expect(frame).toContain("Type your own answer");
    expect(frame).toContain("Submit answer");
    expect(frame).toContain("model gpt-5");
    t.renderer.destroy();
  });

  it("Given compose mode, then the controls render inside the composer box, model first", async () => {
    const t = await testRender(<ChatComposer {...base} mode="compose" inputFocused />, {
      width: 72,
      height: 8,
    });
    await t.renderOnce();
    const lines = t.captureCharFrame().split("\n");
    // The controls sit on a row framed by the composer's left/right border cells.
    const controlsRow = lines.find((line) => line.includes("model gpt-5")) ?? "";
    expect(controlsRow).toContain("model gpt-5");
    expect(controlsRow).toContain("effort high");
    expect(controlsRow.trimStart().startsWith("│") || controlsRow.includes("│")).toBe(true);
    // model precedes the plan/build (^B) chip — matches the web footer order.
    expect(controlsRow.indexOf("model")).toBeLessThan(controlsRow.indexOf("^B"));
    t.renderer.destroy();
  });

  it("Given a staged image, when the composer renders, then it shows a removal affordance", async () => {
    const attachment = {
      relativePath: "docs/diagram.png",
      upload: {
        type: "image" as const,
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
        dataUrl: "data:image/png;base64,/wAA/w==",
      },
      preview: {
        data: new Uint8Array([255, 0, 0, 255]),
        imageWidth: 1,
        imageHeight: 1,
      },
    };
    const t = await testRender(
      <ChatComposer {...base} mode="compose" inputFocused attachments={[attachment]} />,
      { width: 90, height: 10 },
    );
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("× diagram.png");
    expect(frame).toContain("▸ Send");
    t.renderer.destroy();
  });

  it("Given rename mode, when rendered, then it shows the rename label and hint", async () => {
    const frame = await frameOf(
      <ChatComposer {...base} mode="rename" auxValue="old title" inputFocused />,
    );
    expect(frame).toContain("rename");
    expect(frame).toContain("Enter rename");
  });

  it("Given filter mode, when rendered, then it shows the find label and hint", async () => {
    const frame = await frameOf(
      <ChatComposer {...base} mode="filter" auxValue="log" inputFocused />,
    );
    expect(frame).toContain("find");
    expect(frame).toContain("Enter keep");
  });

  it("Given commit mode, when rendered, then it shows the commit label, message, and hint", async () => {
    const frame = await frameOf(
      <ChatComposer {...base} mode="commit" auxValue="fix the bug" inputFocused />,
    );
    expect(frame).toContain("commit");
    expect(frame).toContain("fix the bug");
    expect(frame).toContain("Enter commit");
  });

  it("Given new-thread mode, when rendered, then it shows the dialog, project, and options", async () => {
    const frame = await frameOf(
      <ChatComposer
        {...base}
        mode="new"
        newRuntimeMode="approval-required"
        interactionMode="plan"
        inputFocused
      />,
    );
    expect(frame).toContain("new thread");
    expect(frame).toContain("Acme");
    expect(frame).toContain("approval-required");
    expect(frame).toContain("plan");
    expect(frame).toContain("model ▸ gpt-5");
    expect(frame).toContain("effort ▸ high");
    expect(frame).toContain("branch");
    expect(frame).toContain("Project workspace");
  });

  it("Given New worktree mode, then it shows the selected base branch without a raw path field", async () => {
    const frame = await frameOf(
      <ChatComposer
        {...base}
        mode="new"
        newField="branch"
        newWorkspaceMode="new-worktree"
        newWorkspaceLabel="New worktree"
        newBranch="feature/x"
        newBranchStatus="ready"
        inputFocused
      />,
    );
    expect(frame).toContain("New worktree");
    expect(frame).toContain("base branch");
    expect(frame).toContain("feature/x");
    expect(frame).not.toContain("worktree ▸ /");
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

  it("Given a non-empty reply, when the editor mounts, then it seeds the draft (survives remount)", async () => {
    const frame = await frameOf(
      <ChatComposer {...base} mode="compose" reply="restored draft" inputFocused />,
    );
    expect(frame).toContain("restored draft");
  });

  it("Given a draft, when a global Ctrl-shortcut key is pressed, then the editor keeps the draft", async () => {
    function Harness(): React.ReactNode {
      const [reply, setReply] = React.useState("");
      return (
        <ChatComposer {...base} mode="compose" reply={reply} inputFocused onReplyInput={setReply} />
      );
    }
    const t = await testRender(<Harness />, { width: 60, height: 8 });
    await t.renderOnce();
    await t.mockInput.typeText("keep this draft");
    // ^U / ^K would delete-to-line-start / -end if the editor still owned them.
    t.mockInput.pressKey("u", { ctrl: true });
    t.mockInput.pressKey("k", { ctrl: true });
    const frame = await t.waitForFrame((f) => f.includes("keep this draft"));
    expect(frame).toContain("keep this draft");
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
