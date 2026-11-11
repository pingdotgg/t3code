import { describe, expect, it } from "vite-plus/test";

import { shellStdoutFile } from "./shellStdoutFile.ts";

describe("shellStdoutFile", () => {
  it.each([
    ["vp run dev", undefined],
    ["vp run dev > dev.log 2>&1", "dev.log"],
    ["vp run dev >> dev.log", "dev.log"],
    ["vp run dev 1>dev.log", "dev.log"],
    ["vp run dev &> dev.log", "dev.log"],
    ["vp run dev 2>&1 | tee -a logs/dev.log", "logs/dev.log"],
    ["vp run dev |& tee dev.log", "dev.log"],
    [
      `cd /c/repo; vp run dev > "C:/Users/me/AppData/Local/Temp/dev2.log" 2>&1`,
      "C:/Users/me/AppData/Local/Temp/dev2.log",
    ],
    ["vp run dev > 'my logs/dev.log'", "my logs/dev.log"],
    [String.raw`vp run dev > "C:\Users\me\dev.log"`, String.raw`C:\Users\me\dev.log`],
    ["vp run dev > first.log; vp run dev > second.log", "second.log"],
    // stderr alone, descriptor copies, and discarded output leave stdout on the terminal.
    ["vp run dev 2> errors.log", undefined],
    ["vp run dev >&2", undefined],
    ["vp run dev > /dev/null 2>&1", undefined],
    // Redirect characters inside quotes are arguments, not redirects.
    [`echo "a > b" && node server.js`, undefined],
    [`grep '>' notes.txt`, undefined],
    // Only the shell knows these paths.
    ["vp run dev > $LOG_FILE", undefined],
    [`vp run dev > "$TMPDIR/dev.log"`, undefined],
    ["vp run dev > ~/dev.log", undefined],
  ])("%s", (command, expected) => {
    expect(shellStdoutFile(command)).toBe(expected);
  });
});
