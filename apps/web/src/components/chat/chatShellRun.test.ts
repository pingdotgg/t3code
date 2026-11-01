import { describe, expect, it } from "vite-plus/test";

import {
  chatShellRunInput,
  chatShellRunResultMessage,
  isChatShellRunResultMessage,
  parseChatShellRunOutput,
} from "./chatShellRun";

const ID = "abc123";
const START = `\u001b]7717;T3S;${ID}\u0007`;
const end = (code: number) => `\u001b]7717;T3E;${ID};${code}\u0007`;

describe("chatShellRunInput", () => {
  const input = chatShellRunInput("echo 'hi'\necho two", ID, "/tmp/my project");

  it("sends one history-suppressed line ending in a return", () => {
    expect(input.startsWith(" printf")).toBe(true);
    expect(input.indexOf("\r")).toBe(input.length - 1);
    expect(input).not.toContain("\n");
  });

  it("runs the command in a subshell from the given directory", () => {
    expect(input).toContain(`(cd $'/tmp/my project' && eval $'echo \\'hi\\'\\necho two')`);
  });

  it("shows the command as its user would type it", () => {
    expect(input).toContain(`$'$ echo \\'hi\\'\\n$ echo two'`);
  });
});

describe("parseChatShellRunOutput", () => {
  it("returns the output and exit code of a finished run", () => {
    const raw = `${chatShellRunInput("echo hi", ID, "/tmp")}\n$ echo hi\n${START}hi\n${end(0)}% \n$ `;
    expect(parseChatShellRunOutput(raw, ID)).toEqual({ text: "hi", exitCode: 0 });
  });

  it("reports a non-zero exit code", () => {
    expect(parseChatShellRunOutput(`${START}boom\n${end(2)}`, ID)).toEqual({
      text: "boom",
      exitCode: 2,
    });
  });

  it("keeps the output of a run that has not finished", () => {
    expect(parseChatShellRunOutput(`${START}server starting\n`, ID)).toEqual({
      text: "server starting\n",
      exitCode: null,
    });
  });

  it("returns no text before the start marker is in the stream", () => {
    expect(parseChatShellRunOutput("prompt$ echo hi\r\n", ID)).toEqual({
      text: "",
      exitCode: null,
    });
  });

  it("strips colour and cursor control sequences", () => {
    const raw = `${START}\u001b[31mred\u001b[0m\u001b[2K\n${end(0)}`;
    expect(parseChatShellRunOutput(raw, ID)).toEqual({ text: "red", exitCode: 0 });
  });

  it("keeps only the last state of a line rewritten with carriage returns", () => {
    const raw = `${START}10%\r50%\r100%\r\n${end(0)}`;
    expect(parseChatShellRunOutput(raw, ID)).toEqual({ text: "100%", exitCode: 0 });
  });

  it("still finishes when long output pushed the start marker out of the buffer", () => {
    expect(parseChatShellRunOutput(`tail\n${end(0)}`, ID)).toEqual({ text: "tail", exitCode: 0 });
  });

  it("ignores another run's markers", () => {
    const raw = `\u001b]7717;T3S;other\u0007x\n\u001b]7717;T3E;other;0\u0007`;
    expect(parseChatShellRunOutput(raw, ID)).toEqual({ text: "", exitCode: null });
  });
});

describe("chatShellRunResultMessage", () => {
  it("carries the command, exit code, and output, and is recognised as hidden", () => {
    const message = chatShellRunResultMessage("npm test", { text: "1 failed", exitCode: 1 });
    expect(message).toContain("npm test");
    expect(message).toContain("Exit code: 1");
    expect(message).toContain("1 failed");
    expect(isChatShellRunResultMessage(message)).toBe(true);
  });

  it("keeps the end of very long output", () => {
    const message = chatShellRunResultMessage("x", {
      text: `${"a".repeat(30_000)}END`,
      exitCode: 0,
    });
    expect(message).toContain("Output (last 20000 characters):");
    expect(message).toContain("END");
    expect(message.length).toBeLessThan(21_000);
  });

  it("does not hide ordinary messages", () => {
    expect(isChatShellRunResultMessage("What does <t3_code_block_run> mean?")).toBe(false);
  });
});
