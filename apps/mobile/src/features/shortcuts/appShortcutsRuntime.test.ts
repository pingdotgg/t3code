import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-quick-actions", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../../persistence/imperative", () => ({}));
vi.mock("../../state/atom-registry", () => ({}));
vi.mock("../../state/threads", () => ({ environmentThreadShells: {} }));
vi.mock("./appShortcuts", async () => {
  const { withRecentThreadShortcut } =
    await vi.importActual<typeof import("./appShortcuts")>("./appShortcuts");
  return { withRecentThreadShortcut };
});

import type { RecentThreadShortcut } from "../../persistence/imperative";
import { createRecentThreadShortcuts } from "./appShortcutsRuntime";

const thread = (threadId: string, title = threadId): RecentThreadShortcut => ({
  environmentId: "env",
  threadId,
  title,
});

function setup(load: () => Promise<ReadonlyArray<RecentThreadShortcut>>) {
  const save = vi.fn<(list: ReadonlyArray<RecentThreadShortcut>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const publish = vi.fn<(list: ReadonlyArray<RecentThreadShortcut>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  return { save, publish, recents: createRecentThreadShortcuts({ load, save, publish }) };
}

describe("createRecentThreadShortcuts", () => {
  it("waits for the persisted list before recording the open thread", async () => {
    const { save, publish, recents } = setup(() => Promise.resolve([thread("old")]));
    recents.recordActiveThread(thread("new"));
    expect(publish).not.toHaveBeenCalled();
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([thread("new"), thread("old")]);
    expect(save).toHaveBeenLastCalledWith([thread("new"), thread("old")]);
  });

  it("does not persist the empty fallback after a failed load", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { save, publish, recents } = setup(() => Promise.reject(new Error("read failed")));
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([]);
    expect(save).not.toHaveBeenCalled();

    recents.recordActiveThread(thread("a"));
    await recents.saved();
    expect(save).toHaveBeenLastCalledWith([thread("a")]);
  });

  it("records title changes of the open thread and ignores repeats", async () => {
    const { publish, recents } = setup(() => Promise.resolve([]));
    await recents.loaded;
    recents.recordActiveThread(thread("a", ""));
    recents.recordActiveThread(thread("a", "Named"));
    recents.recordActiveThread(thread("a", "Named"));
    recents.recordActiveThread(null);
    expect(publish.mock.calls.map(([list]) => list)).toEqual([
      [],
      [thread("a", "")],
      [thread("a", "Named")],
    ]);
  });
});
