import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { plainTerminalText } from "./viewModel.ts";

const ESC = "\x1b";

NodeTest.describe("plainTerminalText (plain-text fallback view)", () => {
  NodeTest.it("drops SGR colour codes from a zsh/starship prompt", () => {
    // A captured prompt that printed raw: `[1;36mvca4-workspace [0m on …`.
    const prompt = `${ESC}[1;36mvca4-workspace ${ESC}[0m on ${ESC}[1;35mvca-visual${ESC}[0m\r\n$ `;
    NodeAssert.equal(plainTerminalText(prompt), "vca4-workspace  on vca-visual\n$ ");
  });

  NodeTest.it("drops private-mode, OSC title/hyperlink and charset sequences", () => {
    const raw =
      `${ESC}[?2004h${ESC}]0;/repo\x07${ESC}]8;;https://t3.codes${ESC}\\link${ESC}]8;;${ESC}\\` +
      `${ESC}(B${ESC}=ok${ESC}[?2004l\x07\n`;
    NodeAssert.equal(plainTerminalText(raw), "linkok\n");
  });

  NodeTest.it("applies carriage return and backspace as overwrites", () => {
    NodeAssert.equal(plainTerminalText("progress 10%\rprogress 100%\n"), "progress 100%\n");
    NodeAssert.equal(plainTerminalText("abc\rX\n"), "Xbc\n");
    NodeAssert.equal(plainTerminalText("ab\bX\n"), "aX\n");
    // CRLF is a newline, not an overwrite of the line.
    NodeAssert.equal(plainTerminalText("one\r\ntwo\r\n"), "one\ntwo\n");
  });

  NodeTest.it("holds back a sequence split at the end of the buffer", () => {
    // The rest of the chunk is still in flight; the next render completes it.
    NodeAssert.equal(plainTerminalText(`done ${ESC}[1;3`), "done ");
    NodeAssert.equal(plainTerminalText(`done ${ESC}`), "done ");
    NodeAssert.equal(plainTerminalText(`done ${ESC}]0;tit`), "done ");
    NodeAssert.equal(plainTerminalText(`done ${ESC}]0;title${ESC}`), "done ");
    // Complete sequences at the end are ordinary escapes, not partials.
    NodeAssert.equal(plainTerminalText(`done${ESC}[0m`), "done");
    NodeAssert.equal(plainTerminalText(`done${ESC}(B`), "done");
  });

  NodeTest.it("drops 8-bit C1 string sequences and a stray ST", () => {
    // 8-bit OSC title ended by ST, OSC hyperlink ended by BEL, DCS, APC.
    const raw = "\x9d0;/repo\x9ca\x9d8;;https://t3.codes\x07b\x90q\x1b\\c\x9fapc\x9cd\x9c\n";
    NodeAssert.equal(plainTerminalText(raw), "abcd\n");
    NodeAssert.equal(plainTerminalText("done \x9b1;31mred\x9b0m"), "done red");
  });

  NodeTest.it("drops a malformed unterminated OSC without leaking its payload", () => {
    // The next escape aborts the OSC, as in the VT parser; the escape still applies.
    NodeAssert.equal(plainTerminalText(`a${ESC}]0;title${ESC}[31mb\n`), "ab\n");
    NodeAssert.equal(plainTerminalText("a\x9d0;title\x9b31mb\n"), "ab\n");
    // CAN aborts it too, and an unterminated string at the end is withheld.
    NodeAssert.equal(plainTerminalText(`a${ESC}]0;title\x18b\n`), "ab\n");
    NodeAssert.equal(plainTerminalText("done \x9d0;tit"), "done ");
  });

  NodeTest.it("holds back an 8-bit CSI split at the end of the buffer", () => {
    NodeAssert.equal(plainTerminalText("done \x9b1;3"), "done ");
  });

  NodeTest.it("keeps text, tabs and unicode untouched", () => {
    const text = "a\tb — ünïcode 🙂\n[not an escape]\n";
    NodeAssert.equal(plainTerminalText(text), text);
  });
});
