import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  createTerminalInputCommand,
  TerminalInputBackpressureError,
  type TerminalInputTarget,
} from "./terminalInput.ts";
import type { AtomCommand } from "./runtime.ts";

const target = (data: string, terminalId = "term-1"): TerminalInputTarget => ({
  environmentId: EnvironmentId.make("environment-1"),
  input: {
    threadId: ThreadId.make("thread-1"),
    terminalId,
    data,
  },
});

describe("terminal input command", () => {
  it("coalesces same-task input and preserves its order", async () => {
    const sent: string[] = [];
    const send: AtomCommand<TerminalInputTarget, void, never> = {
      label: "send",
      run: async (_registry, input) => {
        sent.push(input.input.data);
        return AsyncResult.success(undefined);
      },
    };
    const input = createTerminalInputCommand(send);
    const registry = AtomRegistry.make();

    const results = await Promise.all([
      input.run(registry, target("a")),
      input.run(registry, target("b")),
      input.run(registry, target("c")),
    ]);

    expect(sent).toEqual(["abc"]);
    expect(results.every(AsyncResult.isSuccess)).toBe(true);
    registry.dispose();
  });

  it("keeps independent terminal lanes separate", async () => {
    const sent: Array<{ terminalId: string; data: string }> = [];
    const send: AtomCommand<TerminalInputTarget, void, never> = {
      label: "send",
      run: async (_registry, input) => {
        sent.push({ terminalId: input.input.terminalId, data: input.input.data });
        return AsyncResult.success(undefined);
      },
    };
    const input = createTerminalInputCommand(send);
    const registry = AtomRegistry.make();

    await Promise.all([
      input.run(registry, target("a", "term-1")),
      input.run(registry, target("b", "term-2")),
    ]);

    expect(sent).toEqual([
      { terminalId: "term-1", data: "a" },
      { terminalId: "term-2", data: "b" },
    ]);
    registry.dispose();
  });

  it("splits queued input into ordered batches at the configured size", async () => {
    const sent: string[] = [];
    const send: AtomCommand<TerminalInputTarget, void, never> = {
      label: "send",
      run: async (_registry, input) => {
        sent.push(input.input.data);
        return AsyncResult.success(undefined);
      },
    };
    const input = createTerminalInputCommand(send, { maxBatchChars: 3 });
    const registry = AtomRegistry.make();

    const results = await Promise.all([
      input.run(registry, target("ab")),
      input.run(registry, target("cd")),
      input.run(registry, target("e")),
    ]);

    expect(sent).toEqual(["ab", "cde"]);
    expect(results.every(AsyncResult.isSuccess)).toBe(true);
    registry.dispose();
  });

  it("splits a single oversized input into legal ordered writes", async () => {
    const sent: string[] = [];
    const data = `${"a".repeat(65_535)}😀b`;
    const send: AtomCommand<TerminalInputTarget, void, never> = {
      label: "send",
      run: async (_registry, input) => {
        sent.push(input.input.data);
        return AsyncResult.success(undefined);
      },
    };
    const input = createTerminalInputCommand(send);
    const registry = AtomRegistry.make();

    const result = await input.run(registry, target(data));

    expect(sent.map((chunk) => chunk.length)).toEqual([65_535, 3]);
    expect(sent.join("")).toBe(data);
    expect(result._tag).toBe("Success");
    registry.dispose();
  });

  it("preserves surrounding input order when splitting an oversized entry", async () => {
    const sent: string[] = [];
    const send: AtomCommand<TerminalInputTarget, void, never> = {
      label: "send",
      run: async (_registry, input) => {
        sent.push(input.input.data);
        return AsyncResult.success(undefined);
      },
    };
    const input = createTerminalInputCommand(send, { maxBatchChars: 4 });
    const registry = AtomRegistry.make();

    await Promise.all([
      input.run(registry, target("ab")),
      input.run(registry, target("cdefgh")),
      input.run(registry, target("ij")),
    ]);

    expect(sent).toEqual(["ab", "cdef", "gh", "ij"]);
    expect(sent.join("")).toBe("abcdefghij");
    registry.dispose();
  });

  it("reports a failed chunk after sending the rest of an oversized input", async () => {
    const sent: string[] = [];
    const send: AtomCommand<TerminalInputTarget, void, string> = {
      label: "send",
      run: async (_registry, input) => {
        sent.push(input.input.data);
        return input.input.data === "efgh"
          ? AsyncResult.failure(Cause.fail("chunk failed"))
          : AsyncResult.success(undefined);
      },
    };
    const input = createTerminalInputCommand(send, { maxBatchChars: 4 });
    const registry = AtomRegistry.make();

    const result = await input.run(registry, target("abcdefghij"));

    expect(sent).toEqual(["abcd", "efgh", "ij"]);
    expect(result._tag).toBe("Failure");
    registry.dispose();
  });

  it("fails new input when the bounded lane is full", async () => {
    let releaseSend!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const send: AtomCommand<TerminalInputTarget, void, never> = {
      label: "send",
      run: async () => {
        await blocked;
        return AsyncResult.success(undefined);
      },
    };
    const input = createTerminalInputCommand(send, { maxBufferedChars: 2 });
    const registry = AtomRegistry.make();

    const accepted = input.run(registry, target("ab"));
    await Promise.resolve();
    const rejected = await input.run(registry, target("c"));

    expect(rejected._tag).toBe("Failure");
    if (rejected._tag === "Failure") {
      expect(rejected.cause.reasons[0]).toMatchObject({
        _tag: "Fail",
        error: expect.any(TerminalInputBackpressureError),
      });
    }
    releaseSend();
    await accepted;
    registry.dispose();
  });
});
