import * as NodeEvents from "node:events";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { settingsHelperBounds, watchMacSettingsWindow } from "./MacSettingsWindow.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
let child: NodeEvents.EventEmitter & {
  stdout: NodeEvents.EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  child = Object.assign(new NodeEvents.EventEmitter(), {
    stdout: Object.assign(new NodeEvents.EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
});
it("places the helper inside small and large Settings windows across displays", () => {
  for (const x of [-900, 20]) {
    for (const width of [668, 1000]) {
      const state = { x, y: 30, width, height: 700, frontmost: true };
      const helper = settingsHelperBounds(state);
      expect(helper.x).toBeGreaterThanOrEqual(x + 216);
      expect(helper.x + helper.width).toBeLessThanOrEqual(x + width - 16);
      expect(helper.y + helper.height).toBe(714);
    }
  }
});
it("decodes partial updates and stops the one watcher process on disposal", () => {
  const changed = vi.fn();
  const unavailable = vi.fn();
  const stop = watchMacSettingsWindow(changed, unavailable);
  const state = { x: 10, y: 20, width: 723, height: 719, frontmost: true };
  const line = JSON.stringify(state);
  child.stdout.emit("data", line.slice(0, 8));
  expect(changed).not.toHaveBeenCalled();
  child.stdout.emit("data", line.slice(8) + "\nnull\n");
  expect(changed.mock.calls).toEqual([[state], [null]]);
  stop();
  expect(child.kill).toHaveBeenCalledOnce();
  child.emit("exit", 0);
  expect(changed).toHaveBeenCalledTimes(2);
});
it("distinguishes unavailable tracking from a valid absent window", () => {
  const changed = vi.fn();
  const unavailable = vi.fn();
  const stop = watchMacSettingsWindow(changed, unavailable);
  child.stdout.emit("data", '{"x":"bad"}\n');
  expect(changed).not.toHaveBeenCalled();
  expect(unavailable).toHaveBeenCalledOnce();
  child.emit("error", new Error("spawn failed"));
  expect(changed).not.toHaveBeenCalled();
  expect(unavailable).toHaveBeenCalledTimes(2);
  stop();
});
