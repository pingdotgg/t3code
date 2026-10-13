// @effect-diagnostics nodeBuiltinImport:off -- Spawns the real plugin host child to talk to it over fd 3.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";

import { afterEach, describe, expect, it } from "@effect/vitest";

// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;
const FIXTURE_DIR = `${import.meta.dirname}/testFixtures/plugin`;

const children = new Set<NodeChildProcess.ChildProcess>();
afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
});

/** Speaks the raw fd 3 protocol with one plugin child, as the supervisor would. */
const startChild = () => {
  const child = NodeChildProcess.spawn(process.execPath, [BIN_PATH, "__plugin-host"], {
    cwd: FIXTURE_DIR,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  children.add(child);
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("exit", (code, signal) => resolve([code, signal])),
  );
  const channel = child.stdio[3] as NodeStream.Duplex;
  const lines = NodeReadline.createInterface({ input: channel })[Symbol.asyncIterator]();
  return {
    exited,
    send: (line: string) => channel.write(`${line}\n`),
    read: async () => {
      const next = await lines.next();
      return next.done ? undefined : (JSON.parse(next.value) as Record<string, unknown>);
    },
  };
};

const activateMessage = (entry: string) =>
  JSON.stringify({
    _tag: "Activate",
    pluginId: "test.child",
    version: "1.0.0",
    apiVersion: 1,
    entryPath: `${FIXTURE_DIR}/${entry}`,
    proposedApi: true,
    maxMessageBytes: 64 * 1024,
    capabilities: [],
  });

describe("plugin host child", () => {
  it("drops what a plugin registered before its activation failed", async () => {
    const child = startChild();
    child.send(activateMessage("registerThenFail.mjs"));
    // The activation signal aborts before the failure is reported.
    expect(await child.read()).toEqual({
      _tag: "Log",
      level: "info",
      message: "activation-aborted",
    });
    expect(await child.read()).toEqual({
      _tag: "ActivationFailed",
      message: "activation refused",
    });

    child.send(JSON.stringify({ _tag: "Invoke", requestId: 1, handler: "leftover", input: null }));
    expect(await child.read()).toEqual({
      _tag: "Failed",
      requestId: 1,
      message: 'No handler named "leftover".',
    });

    // Deactivation skips the module's deactivate: it never started.
    child.send(JSON.stringify({ _tag: "Deactivate" }));
    expect(await child.read()).toEqual({ _tag: "Deactivated" });
    expect(await child.read()).toBeUndefined();
    expect(await child.exited).toEqual([0, null]);
  });

  it("answers a call cancelled before its handler started", async () => {
    const child = startChild();
    child.send(activateMessage("cancellable.mjs"));
    expect(await child.read()).toEqual({ _tag: "Ready" });

    // Read in one chunk, the cancel lands before the handler can listen for it.
    child.send(
      [
        JSON.stringify({ _tag: "Invoke", requestId: 1, handler: "cooperative", input: null }),
        JSON.stringify({ _tag: "Cancel", requestId: 1 }),
      ].join("\n"),
    );
    expect(await child.read()).toEqual({
      _tag: "Failed",
      requestId: 1,
      message: "Call cancelled.",
    });
  });

  it("exits with a failure on a line that is not JSON", async () => {
    const child = startChild();
    child.send("{not json");
    expect(await child.exited).toEqual([1, null]);
  });
});
