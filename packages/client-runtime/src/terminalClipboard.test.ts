import { describe, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import {
  TerminalClipboardParser,
  createTerminalClipboardSession,
  createTerminalClipboardWriter,
} from "./terminalClipboard.ts";

function base64(text: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function osc(text: string, target = "c", terminator = "\x07") {
  return `\x1b]52;${target};${base64(text)}${terminator}`;
}

describe("terminal OSC 52 clipboard writes", () => {
  it.each(["c", "qc", "cq", "cp", "pc", "s0c", "7c", "cpqs01234567"])(
    "accepts clipboard target list %j",
    (target) => {
      const copy = vi.fn();
      new TerminalClipboardParser(copy).write(osc("text", target), true);
      expect(copy.mock.calls).toEqual([["text"]]);
    },
  );

  it.each(["", "\uFEFFtext", "\uFEFF"])("preserves exact clipboard text %j", (text) => {
    const copy = vi.fn();
    new TerminalClipboardParser(copy).write(osc(text), true);
    expect(copy.mock.calls).toEqual([[text]]);
  });

  it.each(["\x07", "\x1b\\"])(
    "decodes Unicode with terminator %j at every chunk boundary",
    (end) => {
      const text = "Claude: café 界🙂\nsecond line";
      const data = `prompt${osc(text, "c", end)}tail`;
      for (let split = 0; split <= data.length; split += 1) {
        const copy = vi.fn();
        const parser = new TerminalClipboardParser(copy);
        parser.write(data.slice(0, split), true);
        parser.write(data.slice(split), true);
        expect(copy.mock.calls).toEqual([[text]]);
      }
    },
  );

  it("handles single-character chunks and multiple writes", () => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    for (const char of osc("one") + osc("two", "", "\x1b\\")) parser.write(char, true);
    expect(copy.mock.calls).toEqual([["one"], ["two"]]);
  });

  it.each([
    "\x1b]52;c;?\x07",
    "\x1b]52;c;bad!\x07",
    "\x1b]52;c;/w==\x07",
    osc("primary", "p"),
    osc("secondary", "q"),
    "\x1b]0;title\x07",
  ])("ignores unsupported or malformed request %j and recovers", (data) => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write(data + osc("valid"), true);
    expect(copy.mock.calls).toEqual([["valid"]]);
  });

  it("does not complete an ineligible request after focus returns", () => {
    const data = osc("historical");
    for (let split = 1; split < data.length; split += 1) {
      const copy = vi.fn();
      const parser = new TerminalClipboardParser(copy);
      parser.write(data.slice(0, split), false);
      parser.write(data.slice(split) + osc("live"), true);
      expect(copy.mock.calls).toEqual([["live"]]);
    }
  });

  it("drops requests that become ineligible before completion", () => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write("\x1b]52;c;", true);
    parser.write("YQ==", false);
    parser.write("\x07", true);
    expect(copy).not.toHaveBeenCalled();
  });

  it.each(["P", "_", "^", "X"])("exits %s strings on ESC before parsing OSC", (type) => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write(`\x1b${type}${osc("embedded")}\x1b\\${osc("live")}`, true);
    expect(copy.mock.calls).toEqual([["embedded"], ["live"]]);
  });

  it.each(["\x1b]0;unfinished", "\x1b]52;c;YQ==\u009c", "\x1bPtmux;\x1b"])(
    "recovers the first complete request after %j at every chunk boundary",
    (prefix) => {
      const data = prefix + osc("next") + "\x1b\\" + osc("last");
      for (let split = 0; split <= data.length; split += 1) {
        const copy = vi.fn();
        const parser = new TerminalClipboardParser(copy);
        parser.write(data.slice(0, split), true);
        parser.write(data.slice(split), true);
        expect(copy.mock.calls).toEqual([["next"], ["last"]]);
      }
    },
  );

  it.each(["\x1b]0;unfinished", "\x1bPq", "\x1b_ignored"])(
    "does not replay an OSC escape split across focus changes after %j",
    (prefix) => {
      const copy = vi.fn();
      const parser = new TerminalClipboardParser(copy);
      parser.write(prefix + "\x1b", false);
      parser.write(osc("historical").slice(1) + osc("live"), true);
      expect(copy.mock.calls).toEqual([["live"]]);
      copy.mockClear();
      parser.reset();
      parser.write(prefix, false);
      parser.write(osc("live"), true);
      expect(copy.mock.calls).toEqual([["live"]]);
    },
  );

  it.each(["\n", "\r\n", "\t"])("ignores C0 controls %j in wrapped payloads", (separator) => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    const text = "long clipboard text ".repeat(20);
    const encoded = base64(text).replace(/(.{76})/g, `$1${separator}`);
    parser.write(`\x1b]52;c;${encoded}\x07`, true);
    expect(copy.mock.calls).toEqual([[text]]);
  });

  it.each(["\x18", "\x1a", "\x1b[0m"])("recovers from aborted OSC with %j", (cancel) => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write(`\x1b]52;c;YQ==${cancel}\x07${osc("live")}`, true);
    expect(copy.mock.calls).toEqual([["live"]]);
  });

  it("bounds unfinished clipboard data and recovers after the terminator", () => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write("\x1b]52;c;", true);
    const chunk = "YWFh".repeat(16_384);
    for (let index = 0; index < 17; index += 1) parser.write(chunk, true);
    parser.write("\x07" + osc("live"), true);
    expect(copy.mock.calls).toEqual([["live"]]);
  });

  it("drops incomplete requests on reset", () => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write("\x1b]52;c;YQ==", true);
    parser.reset();
    parser.write("\x07" + osc("live"), true);
    expect(copy.mock.calls).toEqual([["live"]]);
  });

  it.each(["\x07", "\x1b\\"])("invalidates a pending copy without losing framing for %j", (end) => {
    const data = osc("old", "c", end);
    for (let split = 1; split < data.length; split += 1) {
      const copy = vi.fn();
      const parser = new TerminalClipboardParser(copy);
      parser.write(data.slice(0, split), true);
      parser.invalidatePendingCopy();
      parser.write(data.slice(split) + osc("live"), true);
      expect(copy.mock.calls).toEqual([["live"]]);
    }
  });
});

function sessionHarness(writeText = vi.fn(async (_text: string) => {})) {
  const write = createTerminalClipboardWriter(writeText);
  const pending: Promise<unknown>[] = [];
  let active = false;
  const session = createTerminalClipboardSession({
    isEligible: () => active,
    onCopy: (text, canWrite) => {
      pending.push(write(text, canWrite));
    },
  });
  const target = { threadId: ThreadId.make("thread"), terminalId: "terminal" };
  return {
    writeText,
    setActive(next: boolean) {
      active = next;
      if (!next) session.invalidate();
    },
    flush: () => Promise.all(pending),
    history(history: string) {
      session.update({
        type: "snapshot",
        snapshot: {
          ...target,
          cwd: "/tmp",
          worktreePath: null,
          status: "running",
          pid: 1,
          history,
          exitCode: null,
          exitSignal: null,
          label: "Terminal 1",
          updatedAt: "2026-09-05T00:00:00Z",
        },
      });
    },
    append(data: string) {
      session.update({ type: "output", ...target, data });
    },
    reset() {
      session.update({ type: "cleared", ...target });
    },
  };
}

describe("terminal clipboard session", () => {
  it("copies live Unicode output once while ignoring initial history and replay", async () => {
    const h = sessionHarness();
    h.setActive(true);
    h.history(osc("history"));
    const text = "\uFEFFClaude: café 界🙂";
    const data = osc(text);
    h.append(data.slice(0, -1));
    h.append(data.slice(-1));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([[text]]);
    h.reset();
    h.append(osc("new"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([[text], ["new"]]);
  });

  it.each(["single", "chunks"])(
    "copies a payload larger than retained output in %s writes",
    async (mode) => {
      const h = sessionHarness();
      h.setActive(true);
      const text = "x".repeat(600 * 1024);
      const data = osc(text);
      if (mode === "single") h.append(data);
      else
        for (let index = 0; index < data.length; index += 16 * 1024)
          h.append(data.slice(index, index + 16 * 1024));
      h.append("later output".repeat(100_000));
      await h.flush();
      expect(h.writeText.mock.calls).toEqual([[text]]);
    },
  );

  it("does not finish a split copy across leaving and returning to the terminal", async () => {
    const h = sessionHarness();
    h.setActive(true);
    h.append(osc("old").slice(0, -1));
    h.setActive(false);
    h.setActive(true);
    h.append("\x07" + osc("live"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([["live"]]);
  });

  it("ignores background output without losing stream framing", async () => {
    const h = sessionHarness();
    h.append(osc("background").slice(0, -1));
    h.setActive(true);
    h.append("\x07" + osc("live"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([["live"]]);
  });

  it.each(["deactivate", "reset"])("revokes queued native writes on %s", async (action) => {
    let finish!: () => void;
    const first = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = sessionHarness(vi.fn(() => first));
    h.setActive(true);
    h.append(osc("first") + osc("queued"));
    if (action === "reset") h.reset();
    else h.setActive(false);
    h.setActive(true);
    finish();
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([["first"]]);
    h.append(osc("current"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([["first"], ["current"]]);
  });
});
