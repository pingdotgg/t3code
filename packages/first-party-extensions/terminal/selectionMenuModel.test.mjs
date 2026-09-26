import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  TERMINAL_CHAT_LABEL_MAX_CHARS,
  TERMINAL_CHAT_TEXT_MAX_CHARS,
  TerminalChatTarget,
  TerminalSelectionMenuFlow,
  addTerminalSelectionToChat,
  buildTerminalChatSelection,
  clampMenuToViewport,
  resolveSelectionActionPosition,
  terminalChatSelectionError,
  terminalContextMenuItems,
  terminalSelectionLineRange,
  terminalSelectionMenuItems,
} from "./selectionMenuModel.ts";

const at = { x: 40, y: 50 };

function makeFlow() {
  const changes = [];
  const flow = new TerminalSelectionMenuFlow((menu) => changes.push(menu));
  return { flow, changes };
}

NodeTest.describe("menu items (native parity, canAddToChat=false)", () => {
  NodeTest.it("selection popup offers Copy only", () => {
    NodeAssert.deepEqual(terminalSelectionMenuItems({ canAddToChat: false }), [
      { id: "copy", label: "Copy" },
    ]);
  });

  NodeTest.it("right-click with a selection: Copy enabled, Paste enabled", () => {
    NodeAssert.deepEqual(terminalContextMenuItems({ hasSelection: true, canAddToChat: false }), [
      { id: "copy", label: "Copy", disabled: false },
      { id: "paste", label: "Paste" },
    ]);
  });

  NodeTest.it("right-click without a selection: Copy disabled, Paste still offered", () => {
    NodeAssert.deepEqual(terminalContextMenuItems({ hasSelection: false, canAddToChat: false }), [
      { id: "copy", label: "Copy", disabled: true },
      { id: "paste", label: "Paste" },
    ]);
  });

  NodeTest.it("keeps native's default of offering Add to chat when allowed", () => {
    NodeAssert.deepEqual(
      terminalContextMenuItems({ hasSelection: false }).map((item) => item.id),
      ["add-to-chat", "copy", "paste"],
    );
  });

  NodeTest.it("the flow omits Add to chat without a chat target", () => {
    const { flow } = makeFlow();
    const popup = flow.openSelectionPopup({ selectionText: "hello", position: at });
    NodeAssert.deepEqual(
      popup.items.map((item) => item.id),
      ["copy"],
    );
    const context = flow.openContextMenu({ selectionText: "hello", position: at });
    NodeAssert.deepEqual(
      context.items.map((item) => item.id),
      ["copy", "paste"],
    );
    NodeAssert.equal(flow.choose(context.requestId, "add-to-chat"), null);
  });
});

NodeTest.describe("TerminalSelectionMenuFlow supersession", () => {
  NodeTest.it("a right-click during the popup cancels the popup", () => {
    const { flow, changes } = makeFlow();
    const popup = flow.openSelectionPopup({ selectionText: "hello-menu", position: at });
    const context = flow.openContextMenu({ selectionText: "hello-menu", position: at });
    NodeAssert.equal(flow.menu, context);
    NodeAssert.equal(flow.isCurrent(popup.requestId), false);
    NodeAssert.equal(flow.choose(popup.requestId, "copy"), null, "stale popup click is a no-op");
    NodeAssert.equal(flow.menu, context, "the stale click leaves the newer menu open");
    NodeAssert.deepEqual(
      changes.map((menu) => menu?.kind ?? null),
      ["selection", "context"],
    );
  });

  NodeTest.it("a stale completion is silent once a newer flow starts", () => {
    const { flow } = makeFlow();
    const context = flow.openContextMenu({ selectionText: null, position: at });
    const choice = flow.choose(context.requestId, "paste");
    NodeAssert.deepEqual(choice, {
      action: "paste",
      requestId: context.requestId,
      clipboardText: null,
      chatSelection: null,
    });
    NodeAssert.equal(flow.menu, null);
    // The action is still in flight: it may report and refocus...
    NodeAssert.equal(flow.isCurrent(choice.requestId), true);
    // ...until a new flow supersedes it.
    flow.openSelectionPopup({ selectionText: "next", position: at });
    NodeAssert.equal(flow.isCurrent(choice.requestId), false);
  });

  NodeTest.it("passive dismissal after a choice does not cancel the in-flight action", () => {
    const { flow } = makeFlow();
    const popup = flow.openSelectionPopup({ selectionText: "hello", position: at });
    const choice = flow.choose(popup.requestId, "copy");
    NodeAssert.equal(choice.clipboardText, "hello");
    flow.dismiss(); // e.g. a blur while the clipboard write is pending
    NodeAssert.equal(flow.isCurrent(choice.requestId), true);
  });

  NodeTest.it("passive dismissal of an open menu invalidates it", () => {
    const { flow, changes } = makeFlow();
    const popup = flow.openSelectionPopup({ selectionText: "hello", position: at });
    flow.dismiss();
    NodeAssert.equal(flow.menu, null);
    NodeAssert.equal(flow.isCurrent(popup.requestId), false);
    NodeAssert.equal(flow.choose(popup.requestId, "copy"), null);
    NodeAssert.deepEqual(changes.at(-1), null);
  });

  NodeTest.it("a disabled Copy resolves to nothing", () => {
    const { flow } = makeFlow();
    const context = flow.openContextMenu({ selectionText: "", position: at });
    NodeAssert.equal(context.items[0].disabled, true);
    NodeAssert.equal(flow.choose(context.requestId, "copy"), null);
    NodeAssert.equal(flow.menu, null);
  });

  NodeTest.it("Copy writes the selection captured when the menu opened", () => {
    const { flow } = makeFlow();
    const context = flow.openContextMenu({ selectionText: "line one\r\n", position: at });
    NodeAssert.deepEqual(flow.choose(context.requestId, "copy"), {
      action: "copy",
      requestId: context.requestId,
      clipboardText: "line one\r\n",
      chatSelection: null,
    });
  });

  NodeTest.it("whitespace-only newline selections count as empty", () => {
    const { flow } = makeFlow();
    NodeAssert.equal(flow.openSelectionPopup({ selectionText: "\n\n", position: at }), null);
    const context = flow.openContextMenu({ selectionText: "\r\n", position: at });
    NodeAssert.equal(context.items[0].disabled, true);
  });

  NodeTest.it("a repeated selection end keeps the open popup", () => {
    const { flow } = makeFlow();
    const first = flow.openSelectionPopup({ selectionText: "hello", position: at });
    const second = flow.openSelectionPopup({ selectionText: "hello", position: { x: 1, y: 1 } });
    NodeAssert.equal(second, first);
    NodeAssert.equal(flow.isCurrent(first.requestId), true);
  });

  NodeTest.it("an empty selection end supersedes an in-flight action", () => {
    const { flow } = makeFlow();
    const context = flow.openContextMenu({ selectionText: null, position: at });
    const choice = flow.choose(context.requestId, "paste");
    NodeAssert.equal(flow.openSelectionPopup({ selectionText: null, position: at }), null);
    NodeAssert.equal(flow.isCurrent(choice.requestId), false);
  });

  NodeTest.it("an emptied selection clears only a current popup or a pending one", () => {
    const { flow } = makeFlow();
    NodeAssert.equal(flow.shouldClearOnEmptySelection(false), false);
    NodeAssert.equal(flow.shouldClearOnEmptySelection(true), true, "pending popup timer");
    flow.openSelectionPopup({ selectionText: "hello", position: at });
    NodeAssert.equal(flow.shouldClearOnEmptySelection(false), true);
    flow.openContextMenu({ selectionText: "hello", position: at });
    NodeAssert.equal(
      flow.shouldClearOnEmptySelection(false),
      false,
      "a right-click menu keeps the text it captured",
    );
  });
});

NodeTest.describe("positioning", () => {
  const bounds = { left: 100, top: 200, width: 400, height: 300 };
  const viewport = { width: 1000, height: 800 };

  NodeTest.it("anchors the popup at the release pointer inside the pane", () => {
    NodeAssert.deepEqual(
      resolveSelectionActionPosition({
        bounds,
        selectionRect: { right: 150, bottom: 220 },
        pointer: { x: 700, y: 10 },
        viewport,
      }),
      { x: 500, y: 200 },
    );
  });

  NodeTest.it("falls back to just below the selection end", () => {
    NodeAssert.deepEqual(
      resolveSelectionActionPosition({
        bounds,
        selectionRect: { right: 150, bottom: 220 },
        pointer: null,
        viewport,
      }),
      { x: 150, y: 224 },
    );
  });

  NodeTest.it("clamps a menu that would overflow the right and bottom edges", () => {
    NodeAssert.deepEqual(
      clampMenuToViewport({
        point: { x: 980, y: 790 },
        size: { width: 120, height: 60 },
        viewport,
      }),
      { x: 876, y: 736 },
    );
  });

  NodeTest.it("keeps a margin at the top-left edges", () => {
    NodeAssert.deepEqual(
      clampMenuToViewport({ point: { x: -5, y: 0 }, size: { width: 120, height: 60 }, viewport }),
      { x: 4, y: 4 },
    );
  });

  NodeTest.it("pins to the margin when the menu is larger than the viewport", () => {
    NodeAssert.deepEqual(
      clampMenuToViewport({
        point: { x: 50, y: 50 },
        size: { width: 2000, height: 2000 },
        viewport,
      }),
      { x: 4, y: 4 },
    );
  });
});

const excerpt = {
  terminalId: "term-1",
  terminalLabel: "Terminal 1",
  lineStart: 3,
  lineEnd: 4,
  text: "$ ls\nsrc",
};

function makeChatFlow(canAddToChat = () => true) {
  return new TerminalSelectionMenuFlow(() => {}, { canAddToChat });
}

NodeTest.describe("Add to chat (native parity with a chat target)", () => {
  NodeTest.it("the popup offers Add to chat then Copy; the right-click adds Paste", () => {
    const flow = makeChatFlow();
    const popup = flow.openSelectionPopup({
      selectionText: "$ ls\nsrc",
      chatSelection: excerpt,
      position: at,
    });
    NodeAssert.deepEqual(popup.items, [
      { id: "add-to-chat", label: "Add to chat" },
      { id: "copy", label: "Copy" },
    ]);
    const context = flow.openContextMenu({
      selectionText: "$ ls\nsrc",
      chatSelection: excerpt,
      position: at,
    });
    NodeAssert.deepEqual(context.items, [
      { id: "add-to-chat", label: "Add to chat", disabled: false },
      { id: "copy", label: "Copy", disabled: false },
      { id: "paste", label: "Paste" },
    ]);
  });

  NodeTest.it("choosing it hands over the excerpt captured when the menu opened", () => {
    const flow = makeChatFlow();
    const context = flow.openContextMenu({
      selectionText: "$ ls\nsrc",
      chatSelection: excerpt,
      position: at,
    });
    NodeAssert.deepEqual(flow.choose(context.requestId, "add-to-chat"), {
      action: "add-to-chat",
      requestId: context.requestId,
      clipboardText: "$ ls\nsrc",
      chatSelection: excerpt,
    });
  });

  NodeTest.it("an empty selection disables it on the right-click menu", () => {
    const flow = makeChatFlow();
    const context = flow.openContextMenu({ selectionText: null, position: at });
    NodeAssert.deepEqual(
      context.items.map((item) => [item.id, item.disabled === true]),
      [
        ["add-to-chat", true],
        ["copy", true],
        ["paste", false],
      ],
    );
    NodeAssert.equal(flow.choose(context.requestId, "add-to-chat"), null);
  });

  NodeTest.it("a newline-only selection ignores a stray excerpt and opens no popup", () => {
    const flow = makeChatFlow();
    const context = flow.openContextMenu({
      selectionText: "\r\n",
      chatSelection: excerpt,
      position: at,
    });
    NodeAssert.equal(context.chatSelection, null);
    NodeAssert.equal(flow.choose(context.requestId, "add-to-chat"), null);
    NodeAssert.equal(
      flow.openSelectionPopup({ selectionText: "\n", chatSelection: excerpt, position: at }),
      null,
    );
  });

  NodeTest.it("a selection without a line range keeps Copy but disables Add to chat", () => {
    const flow = makeChatFlow();
    const popup = flow.openSelectionPopup({ selectionText: "hello", position: at });
    NodeAssert.deepEqual(
      popup.items.map((item) => [item.id, item.disabled === true]),
      [
        ["add-to-chat", true],
        ["copy", false],
      ],
    );
    NodeAssert.equal(flow.choose(popup.requestId, "add-to-chat"), null);
  });

  NodeTest.it("the chat target is read when each menu opens", () => {
    let available = false;
    const flow = makeChatFlow(() => available);
    const before = flow.openContextMenu({
      selectionText: "x",
      chatSelection: excerpt,
      position: at,
    });
    NodeAssert.equal(before.items[0].id, "copy");
    available = true;
    const after = flow.openContextMenu({
      selectionText: "x",
      chatSelection: excerpt,
      position: at,
    });
    NodeAssert.equal(after.items[0].id, "add-to-chat");
  });
});

NodeTest.describe("buildTerminalChatSelection", () => {
  const position = { start: { x: 0, y: 2 }, end: { x: 3, y: 5 } };

  NodeTest.it("keeps multi-line text, folds CRLF, and trims only outer blank lines", () => {
    NodeAssert.deepEqual(
      buildTerminalChatSelection({
        terminalId: "term-2",
        terminalLabel: " Terminal 2 ",
        text: "\r\n$ make\r\n  error: x\r\n\r\n  at y\r\n\r\n",
        position,
      }),
      {
        terminalId: "term-2",
        terminalLabel: "Terminal 2",
        lineStart: 3,
        lineEnd: 6,
        text: "$ make\n  error: x\n\n  at y",
      },
    );
  });

  NodeTest.it("maps 0-based screen rows to native's 1-based line range", () => {
    NodeAssert.deepEqual(terminalSelectionLineRange({ start: { y: 0 }, end: { y: 0 } }), {
      lineStart: 1,
      lineEnd: 1,
    });
    NodeAssert.deepEqual(terminalSelectionLineRange({ start: { y: 4 }, end: { y: 1 } }), {
      lineStart: 5,
      lineEnd: 5,
    });
  });

  NodeTest.it("is null for newline-only text or a missing position", () => {
    const base = { terminalId: "term-1", terminalLabel: "Terminal 1" };
    NodeAssert.equal(buildTerminalChatSelection({ ...base, text: "\r\n\n", position }), null);
    NodeAssert.equal(buildTerminalChatSelection({ ...base, text: "ok", position: null }), null);
  });

  NodeTest.it("keeps the label inside the contract bound", () => {
    const blank = buildTerminalChatSelection({
      terminalId: "term-1",
      terminalLabel: "  ",
      text: "ok",
      position,
    });
    NodeAssert.equal(blank.terminalLabel, "Terminal");
    const label = (terminalLabel) =>
      buildTerminalChatSelection({ terminalId: "term-1", terminalLabel, text: "ok", position })
        .terminalLabel;
    NodeAssert.equal(label("a".repeat(200)), "a".repeat(TERMINAL_CHAT_LABEL_MAX_CHARS));
    // 200 astral code points are 400 UTF-16 units; the bound counts units.
    NodeAssert.equal(label("\u{1F600}".repeat(200)), "\u{1F600}".repeat(64));
    // A cut that would split a surrogate pair drops the whole pair.
    NodeAssert.equal(label(`a${"\u{1F600}".repeat(200)}`), `a${"\u{1F600}".repeat(63)}`);
  });
});

NodeTest.describe("terminalChatSelectionError", () => {
  NodeTest.it("allows the contract maximum and refuses one more character", () => {
    const at = (text) => terminalChatSelectionError({ ...excerpt, text });
    NodeAssert.equal(at("a".repeat(TERMINAL_CHAT_TEXT_MAX_CHARS)), null);
    NodeAssert.match(at("a".repeat(TERMINAL_CHAT_TEXT_MAX_CHARS + 1)), /too long/);
  });

  NodeTest.it("counts UTF-16 units, as the server adapter's schema does", () => {
    const at = (text) => terminalChatSelectionError({ ...excerpt, text });
    const half = TERMINAL_CHAT_TEXT_MAX_CHARS / 2;
    NodeAssert.equal(at("\u{1F600}".repeat(half)), null);
    NodeAssert.match(at("\u{1F600}".repeat(half + 1)), /10,000 characters at most/);
    // 10,000 code points, 10,001 UTF-16 units.
    const mixed = `${"a".repeat(TERMINAL_CHAT_TEXT_MAX_CHARS - 1)}\u{1F600}`;
    NodeAssert.equal([...mixed].length, TERMINAL_CHAT_TEXT_MAX_CHARS);
    NodeAssert.match(at(mixed), /10,000 characters at most/);
  });

  NodeTest.it("refuses a label over 128 UTF-16 units", () => {
    const at = (terminalLabel) => terminalChatSelectionError({ ...excerpt, terminalLabel });
    NodeAssert.equal(at("a".repeat(TERMINAL_CHAT_LABEL_MAX_CHARS)), null);
    NodeAssert.equal(at("\u{1F600}".repeat(64)), null);
    NodeAssert.match(at("\u{1F600}".repeat(65)), /128 characters at most/);
  });
});

function recordingChatAction(overrides = {}) {
  const calls = [];
  let current = true;
  const options = {
    selection: excerpt,
    insert: async (selection) => {
      calls.push(["insert", selection]);
      return { inserted: true, target: "env:thread" };
    },
    isCurrent: () => current,
    clearSelection: () => calls.push(["clearSelection"]),
    focusTerminal: () => calls.push(["focusTerminal"]),
    reportError: (message) => calls.push(["reportError", message]),
    ...overrides,
  };
  return {
    calls,
    supersede: () => {
      current = false;
    },
    run: () => addTerminalSelectionToChat(options),
  };
}

NodeTest.describe("addTerminalSelectionToChat", () => {
  NodeTest.it("inserts, then clears the selection and leaves focus to the composer", async () => {
    const action = recordingChatAction();
    await action.run();
    NodeAssert.deepEqual(action.calls, [["insert", excerpt], ["clearSelection"]]);
  });

  NodeTest.it("a duplicate still clears the selection silently, as native", async () => {
    const action = recordingChatAction({
      insert: async () => ({ inserted: false, reason: "duplicate", target: "env:thread" }),
    });
    await action.run();
    NodeAssert.deepEqual(action.calls, [["clearSelection"]]);
  });

  NodeTest.it("a failure is reported in the terminal and keeps the selection", async () => {
    const action = recordingChatAction({
      insert: async () => {
        throw new Error("composer.context.insertTerminalContext: permission denied");
      },
    });
    await action.run();
    NodeAssert.deepEqual(action.calls, [
      ["reportError", "composer.context.insertTerminalContext: permission denied"],
      ["focusTerminal"],
    ]);
  });

  NodeTest.it("an oversized excerpt is refused before any insert", async () => {
    const action = recordingChatAction({
      selection: { ...excerpt, text: "a".repeat(TERMINAL_CHAT_TEXT_MAX_CHARS + 1) },
    });
    await action.run();
    NodeAssert.equal(action.calls.length, 2);
    NodeAssert.equal(action.calls[0][0], "reportError");
    NodeAssert.match(action.calls[0][1], /10,000 characters at most/);
    NodeAssert.deepEqual(action.calls[1], ["focusTerminal"]);
  });

  NodeTest.it(
    "an astral excerpt within 10,000 code points but over 10,000 UTF-16 units is refused before any insert",
    async () => {
      const text = "\u{1F600}".repeat(TERMINAL_CHAT_TEXT_MAX_CHARS / 2 + 1);
      NodeAssert.ok([...text].length <= TERMINAL_CHAT_TEXT_MAX_CHARS);
      const action = recordingChatAction({ selection: { ...excerpt, text } });
      await action.run();
      NodeAssert.deepEqual(action.calls, [
        ["reportError", "Selection is too long to add to chat (10,000 characters at most)."],
        ["focusTerminal"],
      ]);
    },
  );

  NodeTest.it("an excerpt of exactly 10,000 UTF-16 units is inserted", async () => {
    const selection = { ...excerpt, text: "\u{1F600}".repeat(TERMINAL_CHAT_TEXT_MAX_CHARS / 2) };
    const action = recordingChatAction({ selection });
    await action.run();
    NodeAssert.deepEqual(action.calls, [["insert", selection], ["clearSelection"]]);
  });

  NodeTest.it("an astral label over 128 UTF-16 units is refused before any insert", async () => {
    const action = recordingChatAction({
      selection: { ...excerpt, terminalLabel: "\u{1F600}".repeat(65) },
    });
    await action.run();
    NodeAssert.deepEqual(action.calls, [
      ["reportError", "Terminal name is too long to add to chat (128 characters at most)."],
      ["focusTerminal"],
    ]);
  });

  NodeTest.it("a superseded completion touches neither the selection nor focus", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ok = recordingChatAction({ insert: () => gate });
    const running = ok.run();
    ok.supersede();
    release({ inserted: true, target: "env:thread" });
    await running;
    NodeAssert.deepEqual(ok.calls, []);

    const failed = recordingChatAction({
      insert: async () => {
        failed.supersede();
        throw new Error("gone");
      },
    });
    await failed.run();
    NodeAssert.deepEqual(failed.calls, []);
  });
});

NodeTest.describe("TerminalChatTarget", () => {
  NodeTest.it("re-probes until the composer is there, one probe at a time", async () => {
    const answers = [false, true];
    let probes = 0;
    let settle;
    const target = new TerminalChatTarget(() => {
      probes += 1;
      return new Promise((resolve) => {
        settle = () => resolve(answers.shift());
      });
    });
    target.refresh();
    target.refresh();
    NodeAssert.equal(probes, 1, "no overlapping probe");
    settle();
    await new Promise((resolve) => setImmediate(resolve));
    NodeAssert.equal(target.available, false);
    target.refresh();
    NodeAssert.equal(probes, 2);
    settle();
    await new Promise((resolve) => setImmediate(resolve));
    NodeAssert.equal(target.available, true);
    target.refresh();
    NodeAssert.equal(probes, 2, "a yes is final");
  });

  NodeTest.it("a failed probe leaves it unavailable and retryable", async () => {
    let probes = 0;
    const target = new TerminalChatTarget(async () => {
      probes += 1;
      throw new Error("host unavailable");
    });
    target.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    NodeAssert.equal(target.available, false);
    target.refresh();
    NodeAssert.equal(probes, 2);
  });
});
