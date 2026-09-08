import { assert, beforeEach, it, vi } from "vite-plus/test";

const { byPid, list, on, postMessage } = vi.hoisted(() => ({
  byPid: vi.fn(),
  list: vi.fn(),
  on: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({ parentPort: { on, postMessage } }));
vi.mock("@crowecawcaw/xa11y", () => ({ App: { byPid, list } }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

it.each(["lookup", "children"])("falls back to enumeration after a failed %s", async (failure) => {
  const error = new Error("Unavailable");
  if (failure === "lookup") byPid.mockRejectedValue(error);
  else byPid.mockResolvedValue({ children: () => Promise.reject(error) });
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const focus = vi.fn().mockResolvedValue(undefined);
  list.mockResolvedValue([{ pid: 42, asElement: () => ({ name: "T3", bounds, focus }) }]);
  await import("./WindowsForegroundFocusWorker.ts");
  await vi.dynamicImportSettled();
  const result = Promise.withResolvers<unknown>();
  postMessage.mockImplementation(result.resolve);
  on.mock.calls[0]![1]({
    type: "focus",
    requestId: 1,
    target: { windowId: 1, processId: 42, title: "T3", bounds, contentBounds: bounds },
  });
  assert.deepEqual(await result.promise, { type: "result", requestId: 1, focused: true });
  assert.lengthOf(focus.mock.calls, 1);
});
