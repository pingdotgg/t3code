import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  TERMINAL_INPUT_PENDING_BUDGET,
  TERMINAL_INPUT_SERIALIZED_BUDGET,
  TerminalInputQueue,
  isKnownNonWriteError,
  serializedHead,
  serializedStringBytes,
  serializedWriteBytes,
} from "./inputQueue.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeQueue({ write = () => Promise.resolve({}), ...options } = {}) {
  const sent = [];
  const queue = new TerminalInputQueue({
    terminalId: "term-1",
    write: (data) => {
      sent.push(data);
      return write(data);
    },
    ...options,
  });
  return { queue, sent };
}

NodeTest.describe("serialized batching", () => {
  NodeTest.it("measures the write invocation in UTF-8 JSON bytes, not string length", () => {
    // ESC is 1 UTF-16 unit but serializes as \u001b — 6 bytes.
    const esc = "";
    NodeAssert.equal(esc.length, 1);
    NodeAssert.equal(serializedStringBytes(esc), 2 + 6);
    NodeAssert.equal(
      serializedWriteBytes("term-1", "a"),
      new TextEncoder().encode(JSON.stringify({ terminalId: "term-1", data: "a" })).byteLength,
    );
  });

  NodeTest.it("preserves order and coalesces input behind an in-flight write", async () => {
    const { queue, sent } = makeQueue();
    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    await flush();
    // "a" drains immediately; "b"+"c" coalesce behind it — order is preserved.
    NodeAssert.deepEqual(sent, ["a", "bc"]);
    queue.dispose();
  });

  NodeTest.it("splits a single oversized input at the serialized budget", async () => {
    const { queue, sent } = makeQueue();
    queue.enqueue("x".repeat(100_000));
    await flush();
    NodeAssert.ok(sent.length >= 3);
    for (const data of sent) {
      NodeAssert.ok(
        serializedWriteBytes("term-1", data) <= TERMINAL_INPUT_SERIALIZED_BUDGET,
        `batch ${data.length} chars exceeds the serialized budget`,
      );
    }
    NodeAssert.equal(sent.join(""), "x".repeat(100_000));
    queue.dispose();
  });

  NodeTest.it("packs the longest pending prefix per write", async () => {
    const { queue, sent } = makeQueue({ serializedBudget: 100 });
    // overhead ≈ 37 bytes → ~63 payload bytes per write: two 30-char items
    // merge, the third rolls to the next write.
    queue.enqueue("a".repeat(30));
    queue.enqueue("b".repeat(30));
    queue.enqueue("c".repeat(30));
    await flush();
    NodeAssert.equal(sent.length, 2);
    NodeAssert.equal(sent[0] + sent[1], "a".repeat(30) + "b".repeat(30) + "c".repeat(30));
    for (const data of sent) {
      NodeAssert.ok(serializedWriteBytes("term-1", data) <= 100);
    }
    queue.dispose();
  });

  NodeTest.it("never splits a surrogate pair at a batch boundary", async () => {
    const { queue, sent } = makeQueue({ serializedBudget: 60 });
    // Force a split landing inside an astral character.
    queue.enqueue("ab💩cd".repeat(30));
    await flush();
    NodeAssert.ok(sent.length > 1);
    for (const data of sent) {
      NodeAssert.equal(
        [...data].every((ch) => ch.codePointAt(0) <= 0x10ffff),
        true,
      );
      NodeAssert.doesNotMatch(data, /[\uD800-\uDFFF]/u);
    }
    NodeAssert.equal(sent.join(""), "ab💩cd".repeat(30));
    queue.dispose();
  });

  NodeTest.it("serializedHead never returns a lone surrogate", () => {
    const head = serializedHead("a💩b", 1 + 4); // 'a' (1) + '💩' (4 utf8) fit exactly
    NodeAssert.equal(head, "a💩");
    const cut = serializedHead("a💩b", 3); // 💩 needs 4 — head stops before it
    NodeAssert.equal(cut, "a");
  });
});

NodeTest.describe("pending bound + failure semantics", () => {
  NodeTest.it("rejects new input past the 256 KiB serialized cap without evicting", async () => {
    const gate = new Promise(() => {});
    const { queue } = makeQueue({ write: () => gate });
    const item = "x".repeat(64 * 1024);
    let last = "accepted";
    for (let i = 0; i < 5; i += 1) last = queue.enqueue(item);
    NodeAssert.equal(last, "dropped-full");
    // The accepted items are still pending — nothing was evicted.
    NodeAssert.ok(queue.state.queuedBytes <= TERMINAL_INPUT_PENDING_BUDGET);
    NodeAssert.ok(queue.state.queuedBytes > TERMINAL_INPUT_PENDING_BUDGET - 70 * 1024);
    queue.dispose();
  });

  NodeTest.it(
    "unknown write outcome halts the queue and discards the failed batch + pending",
    async () => {
      const { queue, sent } = makeQueue({
        write: (data) =>
          data.includes("FAIL") ? Promise.reject(new Error("socket reset")) : Promise.resolve({}),
        serializedBudget: 55, // FAIL-batch drains alone; the behind-* items stay pending
      });
      queue.enqueue("ok-1");
      await flush();
      NodeAssert.deepEqual(sent, ["ok-1"]);
      queue.enqueue("FAIL-batch");
      queue.enqueue("behind-1");
      queue.enqueue("behind-2");
      await flush();
      NodeAssert.deepEqual(sent, ["ok-1", "FAIL-batch"]);
      NodeAssert.equal(queue.state.stopped, true);
      NodeAssert.equal(queue.state.queuedCount, 0);
      // New input drops while stopped.
      NodeAssert.equal(queue.enqueue("later"), "dropped-stopped");
      await flush();
      NodeAssert.deepEqual(sent, ["ok-1", "FAIL-batch"]);
      queue.dispose();
    },
  );

  NodeTest.it("resume clears the stop and only post-resume input flows", async () => {
    const { queue, sent } = makeQueue({
      write: (data) =>
        data.includes("FAIL") ? Promise.reject(new Error("socket reset")) : Promise.resolve({}),
    });
    queue.enqueue("FAIL");
    queue.enqueue("dropped");
    await flush();
    NodeAssert.equal(queue.state.stopped, true);
    queue.resume();
    NodeAssert.equal(queue.state.stopped, false);
    // Pre-failure input is never resent; only new input sends.
    NodeAssert.equal(queue.enqueue("fresh"), "accepted");
    await flush();
    NodeAssert.equal(sent.length, 2);
    NodeAssert.ok(sent[0].startsWith("FAIL"));
    NodeAssert.equal(sent[1], "fresh");
    queue.dispose();
  });

  NodeTest.it("known pre-write failures stop input with the known message", async () => {
    const { queue } = makeQueue({
      write: () =>
        Promise.reject(new Error("Terminal session is unavailable in the requested workspace.")),
    });
    queue.enqueue("x");
    await flush();
    NodeAssert.equal(queue.state.stopped, true);
    NodeAssert.match(queue.state.message, /unavailable in the requested workspace/);
    NodeAssert.doesNotMatch(queue.state.message, /partial input/);
    queue.dispose();
  });

  NodeTest.it("unknown failures carry the partial-input warning", async () => {
    const { queue } = makeQueue({
      write: () => Promise.reject(new Error("Terminal control operation failed.")),
    });
    queue.enqueue("x");
    await flush();
    NodeAssert.equal(queue.state.stopped, true);
    NodeAssert.match(queue.state.message, /partial input/);
    queue.dispose();
  });

  NodeTest.it("head-of-line timeout stops input as unknown outcome", async () => {
    const { queue } = makeQueue({
      write: () => new Promise(() => {}),
      writeTimeoutMs: 10,
    });
    queue.enqueue("x");
    await new Promise((resolve) => setTimeout(resolve, 60));
    NodeAssert.equal(queue.state.stopped, true);
    NodeAssert.match(queue.state.message, /timed out/);
    queue.dispose();
  });

  NodeTest.it(
    "gates draining while starting; reset clears pending + stopped for a new epoch",
    async () => {
      const { queue, sent } = makeQueue({
        write: (data) =>
          data === "boom" ? Promise.reject(new Error("socket reset")) : Promise.resolve({}),
      });
      queue.setReady(false);
      queue.enqueue("staged");
      await flush();
      NodeAssert.deepEqual(sent, []);
      queue.setReady(true);
      await flush();
      NodeAssert.deepEqual(sent, ["staged"]);
      queue.enqueue("boom");
      await flush();
      NodeAssert.equal(queue.state.stopped, true);
      queue.reset();
      NodeAssert.equal(queue.state.stopped, false);
      NodeAssert.equal(queue.state.queuedCount, 0);
      queue.enqueue("post-reset");
      await flush();
      NodeAssert.deepEqual(sent, ["staged", "boom", "post-reset"]);
      queue.dispose();
    },
  );
});

NodeTest.describe("paste failure injection", () => {
  const OPEN = "[200~";
  const CLOSE = "[201~";
  const payload = "printf 'pwned\\n' && echo done\n";

  async function injectAt(failOn) {
    const { queue, sent } = makeQueue({
      serializedBudget: 48, // ~11 payload bytes per write → each paste piece drains alone
      write: (data) => {
        if (failOn(data)) return Promise.reject(new Error("socket reset"));
        return Promise.resolve({});
      },
    });
    queue.enqueue(OPEN);
    queue.enqueue(payload);
    queue.enqueue(CLOSE);
    queue.enqueue("follow-up");
    await flush();
    queue.dispose();
    return sent;
  }

  NodeTest.it("a lost opening marker never releases the payload", async () => {
    const sent = await injectAt((data) => data.includes("200~"));
    NodeAssert.equal(sent.length, 1);
    NodeAssert.ok(!sent.join("").includes("printf"));
    NodeAssert.ok(!sent.join("").includes("201~"));
  });

  NodeTest.it("a lost payload never lets the closing marker or follow-up through", async () => {
    const sent = await injectAt((data) => data.includes("printf"));
    NodeAssert.ok(!sent.join("").includes("201~"));
    NodeAssert.ok(!sent.join("").includes("follow-up"));
  });

  NodeTest.it("a lost closing marker halts before follow-up input", async () => {
    const sent = await injectAt((data) => data.includes("201~"));
    NodeAssert.ok(!sent.join("").includes("follow-up"));
  });
});

NodeTest.describe("known-failure classification", () => {
  NodeTest.it("classifies pre-write failures as known", () => {
    for (const message of [
      "Terminal authority is unavailable.",
      "Terminal session is unavailable in the requested workspace.",
      "Invalid terminal control request.",
      "Capability denied",
      "View is inactive",
    ]) {
      NodeAssert.equal(isKnownNonWriteError(new Error(message)), true, message);
    }
  });

  NodeTest.it("treats post-send and transport failures as unknown", () => {
    for (const message of [
      "Terminal control operation failed.",
      "socket reset",
      "Terminal write timed out",
    ]) {
      NodeAssert.equal(isKnownNonWriteError(new Error(message)), false, message);
    }
  });
});
