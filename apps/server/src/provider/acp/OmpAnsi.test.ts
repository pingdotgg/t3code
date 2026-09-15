import { describe, expect, it } from "vite-plus/test";

import { makeAnsiFilter, stripAnsi } from "./OmpAnsi.ts";

/** One line of real `/context` output, as omp writes it into chat text. */
const CONTEXT_LINE =
  "\u001B[38;2;107;114;128m\u2591\u001B[39m\u001B[38;2;156;163;176m\u2591\u001B[39m\u001B[1m\u001B[38;2;0;180;255m\u2591\u001B[22m\u001B[39m 1% 10384 tokens System tools";

describe("stripAnsi", () => {
  it("keeps the text omp drew and drops the escapes", () => {
    expect(stripAnsi(CONTEXT_LINE)).toBe("\u2591\u2591\u2591 1% 10384 tokens System tools");
  });

  it("drops OSC hyperlinks and two-character escapes", () => {
    expect(stripAnsi("\u001B]8;;https://omp.sh\u0007omp\u001B]8;;\u0007\u001B(B done")).toBe(
      "omp done",
    );
  });

  it("leaves text without escapes untouched", () => {
    expect(stripAnsi("Context window: 1000000 tokens (4% used)")).toBe(
      "Context window: 1000000 tokens (4% used)",
    );
  });
});

describe("makeAnsiFilter", () => {
  it("strips a sequence split across chunk boundaries", () => {
    const filter = makeAnsiFilter();
    const chunks = ["bar \u001B[38;2;0", ";180;255m", "\u2591\u001B[39m tail"];
    const output = chunks.map((chunk) => filter.push(chunk)).join("") + filter.flush();

    expect(output).toBe("bar \u2591 tail");
  });

  it("never withholds ordinary text", () => {
    const filter = makeAnsiFilter();

    expect(filter.push("plain text")).toBe("plain text");
    expect(filter.flush()).toBe("");
  });

  it("keeps text printed after a terminated hyperlink in the same chunk", () => {
    const filter = makeAnsiFilter();

    expect(filter.push("\u001B]8;;http://x\u0007label after")).toBe("label after");
    expect(filter.flush()).toBe("");
  });

  it("still holds an unterminated hyperlink until it closes", () => {
    const filter = makeAnsiFilter();

    expect(filter.push("start \u001B]8;;http://x")).toBe("start ");
    expect(filter.push("\u0007label")).toBe("label");
  });

  it("discards a partial escape that the stream never completed", () => {
    const filter = makeAnsiFilter();

    expect(filter.push("done \u001B[38;2")).toBe("done ");
    expect(filter.flush()).toBe("");
  });
});
