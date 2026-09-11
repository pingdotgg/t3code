// @effect-diagnostics nodeBuiltinImport:off -- Exercise the bundled KWin script in an isolated JS context.
import * as NodeFSP from "node:fs/promises";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";

const source = await NodeFSP.readFile(new URL("./activate.js", import.meta.url), "utf8");
function signal() {
  const callbacks: Array<(...args: unknown[]) => void> = [];
  return {
    connect: (callback: (...args: unknown[]) => void) => callbacks.push(callback),
    emit: (...args: unknown[]) => callbacks.forEach((callback) => callback(...args)),
  };
}
function fixture() {
  const windows: Array<{
    pid: number;
    caption: string;
    minimized: boolean;
    captionChanged: ReturnType<typeof signal>;
  }> = [];
  const replies: unknown[] = [];
  const workspace = {
    windowList: () => windows,
    activeWindow: undefined as (typeof windows)[number] | undefined,
    windowAdded: signal(),
    windowActivated: signal(),
  };
  const timeout = signal();
  let stopped = false;
  class Timer {
    timeout = timeout;
    start() {}
    stop() {
      stopped = true;
    }
  }
  return {
    windows,
    workspace,
    replies,
    timeout,
    stopped: () => stopped,
    run: () =>
      NodeVM.runInNewContext(source, {
        workspace,
        QTimer: Timer,
        targetPid: 123,
        targetTitle: "Draft",
        reply: (value: unknown) => replies.push(value),
      }),
  };
}

it("waits for a remapped T3 window and its title before activating", () => {
  const f = fixture();
  f.run();
  const other = { pid: 999, caption: "Draft", minimized: false, captionChanged: signal() };
  f.windows.push(other);
  f.workspace.windowAdded.emit(other);
  expect(f.replies).toEqual([]);
  const target = { pid: 123, caption: "", minimized: true, captionChanged: signal() };
  f.windows.push(target);
  f.workspace.windowAdded.emit(target);
  expect(f.replies).toEqual([]);
  target.caption = "Draft";
  target.captionChanged.emit();
  expect(f.workspace.activeWindow).toBe(target);
  expect(target.minimized).toBe(false);
  expect(f.replies).toEqual([{ activated: true }]);
  expect(f.stopped()).toBe(true);
});

it("rejects ambiguous destinations and ends a wait without activating a lookalike", () => {
  const f = fixture();
  f.windows.push(
    ...[1, 2].map(() => ({
      pid: 123,
      caption: "Draft",
      minimized: false,
      captionChanged: signal(),
    })),
  );
  f.run();
  expect(f.replies).toEqual([{ activated: false }]);
  expect(f.workspace.activeWindow).toBeUndefined();
  const waiting = fixture();
  waiting.run();
  waiting.timeout.emit();
  expect(waiting.replies).toEqual([{ activated: false }]);
  expect(waiting.stopped()).toBe(true);
});
