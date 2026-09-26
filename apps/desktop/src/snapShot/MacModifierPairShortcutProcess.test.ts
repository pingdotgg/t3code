import { describe, expect, it, vi } from "vite-plus/test";

const { spawnedPollers } = vi.hoisted(() => ({
  spawnedPollers: [] as Array<{
    command: string;
    args: ReadonlyArray<string>;
    kill: ReturnType<typeof vi.fn>;
    emitStderr: (text: string) => void;
    emitExit: (code: number) => void;
  }>,
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: ReadonlyArray<string>) => {
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const onceListeners = new Map<string, Array<(value?: unknown) => void>>();
    const record = {
      command,
      args,
      kill: vi.fn(() => true),
      emitStderr: (text: string) => {
        for (const listener of stderrListeners) listener(Buffer.from(text));
      },
      emitExit: (code: number) => {
        for (const listener of onceListeners.get("exit") ?? []) listener(code);
      },
    };
    spawnedPollers.push(record);
    const child = {
      stderr: {
        on: (_event: "data", listener: (chunk: Buffer) => void) => {
          stderrListeners.push(listener);
          return child;
        },
      },
      once: (event: string, listener: (value?: unknown) => void) => {
        onceListeners.set(event, [...(onceListeners.get(event) ?? []), listener]);
        return child;
      },
      kill: record.kill,
    };
    return child;
  },
}));

import { startMacModifierPairShortcutProcess } from "./MacModifierPairShortcutProcess.ts";

describe("macOS modifier pair poller", () => {
  it("resolves on ready, triggers on lines, and kills on stop", async () => {
    spawnedPollers.length = 0;
    const onTrigger = vi.fn();
    const onFailure = vi.fn();
    const started = startMacModifierPairShortcutProcess("meta", onTrigger, onFailure);
    const poller = spawnedPollers[0]!;
    expect(poller.command).toBe("/usr/bin/osascript");
    expect(poller.args.slice(-2)).toEqual(["8", "16"]);

    poller.emitStderr("ready\ntrig");
    const stop = await started;
    poller.emitStderr("ger\ntrigger\n");
    expect(onTrigger).toHaveBeenCalledTimes(2);

    stop();
    expect(poller.kill).toHaveBeenCalledOnce();
    poller.emitStderr("trigger\n");
    expect(onTrigger).toHaveBeenCalledTimes(2);
    poller.emitExit(0);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports an unexpected exit after startup", async () => {
    spawnedPollers.length = 0;
    const onFailure = vi.fn();
    const started = startMacModifierPairShortcutProcess("shift", () => undefined, onFailure);
    const poller = spawnedPollers[0]!;
    poller.emitStderr("ready\n");
    await started;

    poller.emitExit(1);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("rejects when the poller dies before it is ready", async () => {
    spawnedPollers.length = 0;
    const started = startMacModifierPairShortcutProcess(
      "control",
      () => undefined,
      () => undefined,
    );
    spawnedPollers[0]!.emitExit(1);
    await expect(started).rejects.toThrow(/exited with code 1/);
  });
});
