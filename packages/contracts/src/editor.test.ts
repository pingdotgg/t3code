import { expect, it } from "vite-plus/test";

import { buildTerminalEditorCommand } from "./editor.ts";

it.each([
  { target: "/work/dir", command: "nvim -- '/work/dir'" },
  { target: "/work/a.ts:12", command: "nvim '+call cursor(12,1)' -- '/work/a.ts'" },
  { target: "/work/a.ts:12:4", command: "nvim '+call cursor(12,4)' -- '/work/a.ts'" },
  { target: "/work/it's $HOME;x.ts", command: `nvim -- '/work/it'\\''s $HOME;x.ts'` },
])("builds a quoted command for $target", ({ target, command }) => {
  expect(buildTerminalEditorCommand("neovim", target)).toBe(command);
});

// A PTY acts on these before the shell parses the line, so quoting cannot contain them.
it.each(["/work/a\u0003; rm -rf ~\r.ts", "/work/a\n.ts", "/work/a\u007f.ts"])(
  "refuses control characters in %j",
  (target) => {
    expect(buildTerminalEditorCommand("neovim", target)).toBeUndefined();
  },
);

it("has no command for an editor the server launches", () => {
  expect(buildTerminalEditorCommand("vscode", "/work/a.ts")).toBeUndefined();
});
