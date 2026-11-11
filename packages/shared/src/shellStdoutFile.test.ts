import { describe, expect, it } from "vite-plus/test";

import { shellStdoutFile } from "./shellStdoutFile.ts";

describe("shellStdoutFile", () => {
  it.each([
    ["vp run dev", undefined],
    ["vp run dev > dev.log 2>&1", "dev.log"],
    ["vp run dev >> dev.log", "dev.log"],
    ["vp run dev 1>dev.log", "dev.log"],
    ["vp run dev &> dev.log", "dev.log"],
    ["vp run dev > dev.log 2>&1 &", "dev.log"],
    ["vp run dev 2>&1 | tee -a logs/dev.log", "logs/dev.log"],
    ["vp run dev |& tee dev.log", "dev.log"],
    ["echo foo2>file.txt", "file.txt"],
    ["PORT=$(get-port) vp run dev > dev.log", "dev.log"],
    [
      `cd /c/repo; vp run dev > "C:/Users/me/AppData/Local/Temp/dev2.log" 2>&1`,
      "C:/Users/me/AppData/Local/Temp/dev2.log",
    ],
    ["vp run dev > 'my logs/dev.log'", "my logs/dev.log"],
    [String.raw`vp run dev > "C:\Users\me\dev.log"`, String.raw`C:\Users\me\dev.log`],
    ["vp run dev > first.log; vp run dev > second.log", "second.log"],
    ["vp run dev > dev.log # > other.log", "dev.log"],
    // Only the last command's stdout counts: earlier commands finished before it started.
    ["npm run build > build.log && npm run dev", undefined],
    ["echo starting > status.txt; npm run dev", undefined],
    ["cat > run.sh <<'EOF'\necho hi > inner.log\nEOF\nbash run.sh", undefined],
    // stderr alone, descriptor copies, devices, and a bare tee leave stdout on the terminal.
    ["vp run dev 2> errors.log", undefined],
    ["vp run dev >&2", undefined],
    ["vp run dev > dev.log >&2", undefined],
    ["vp run dev > /dev/null 2>&1", undefined],
    ["curl example.com > /dev/stderr", undefined],
    ["vp run dev | tee -a", undefined],
    // Redirect characters inside quotes are arguments, not redirects.
    [`echo "a > b" && node server.js`, undefined],
    [`grep '>' notes.txt`, undefined],
    // Only the shell knows these paths and directories.
    ["vp run dev > $LOG_FILE", undefined],
    [`vp run dev > "$TMPDIR/dev.log"`, undefined],
    ["vp run dev > ~/dev.log", undefined],
    ["cd $APP && vp run dev > dev.log", undefined],
    ["(cd web && npm run dev) > dev.log", undefined],
  ])("%s", (command, expected) => {
    expect(shellStdoutFile(command)?.path).toBe(expected);
  });

  it("keeps the directories the command changes into before writing", () => {
    expect(shellStdoutFile("cd apps/web && cd .. && vp run dev > dev.log 2>&1 &")).toEqual({
      path: "dev.log",
      cwdChanges: ["apps/web", ".."],
    });
  });
});
