import { describe, expect, it } from "vite-plus/test";

import { EDITORS, isTerminalId, TERMINAL_IDS, terminalLabel } from "./editor.ts";

describe("terminal ids", () => {
  // Terminals ride the editor launch path but are their own UI action, so the
  // ids have to stay tellable apart from the apps the Open-in picker lists.
  it("classifies exactly the terminal definitions as terminals", () => {
    expect(TERMINAL_IDS.length).toBeGreaterThan(0);
    expect(EDITORS.filter((editor) => isTerminalId(editor.id)).map((editor) => editor.id)).toEqual([
      ...TERMINAL_IDS,
    ]);

    expect(isTerminalId("vscode")).toBe(false);
    expect(isTerminalId("file-manager")).toBe(false);
  });

  it("labels every terminal and nothing else", () => {
    for (const terminal of TERMINAL_IDS) {
      expect(terminalLabel(terminal)).toBeTruthy();
    }

    expect(terminalLabel("vscode")).toBeNull();
  });

  // A terminal takes a directory, so it must not inherit a file-oriented
  // launch style by accident.
  it("gives every terminal a working-directory launch", () => {
    for (const editor of EDITORS) {
      if (!isTerminalId(editor.id)) continue;
      expect(editor.launchStyle).toBe("working-directory");
    }
  });

  // Editors are listed first so a fresh install with no stored preference
  // still falls back to an editor rather than a terminal.
  it("orders terminals after every editor", () => {
    const ids = EDITORS.map((editor) => editor.id);
    const firstTerminal = ids.findIndex((id) => isTerminalId(id));
    const lastEditor = ids.reduce(
      (last, id, index) => (isTerminalId(id) || id === "file-manager" ? last : index),
      -1,
    );

    expect(firstTerminal).toBeGreaterThan(lastEditor);
  });
});
