import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistence = vi.hoisted(() => ({
  load: vi.fn<() => Promise<ScopedThreadRef | null>>(),
  save: vi.fn<(_thread: ScopedThreadRef) => Promise<void>>(),
  clear: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../persistence/imperative", () => ({
  loadBackgroundConnectionRetainedThread: persistence.load,
  saveBackgroundConnectionRetainedThread: persistence.save,
  clearBackgroundConnectionRetainedThread: persistence.clear,
}));

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const firstThread = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const secondThread = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-2"),
};

beforeEach(() => {
  vi.resetModules();
  persistence.load.mockReset();
  persistence.save.mockReset();
  persistence.clear.mockReset();
  persistence.load.mockResolvedValue(null);
  persistence.save.mockResolvedValue(undefined);
  persistence.clear.mockResolvedValue(undefined);
});

describe("background retained thread", () => {
  it("retries a transient cold-load failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    persistence.load.mockRejectedValueOnce(new Error("storage unavailable"));
    persistence.load.mockResolvedValueOnce(firstThread);
    const retained = await import("./retained-thread");

    try {
      await expect(retained.ensureBackgroundConnectionRetainedThreadLoaded()).resolves.toBeNull();
      expect(retained.getBackgroundConnectionRetainedThreadSnapshot()).toEqual({
        loaded: false,
        thread: null,
      });

      await expect(retained.ensureBackgroundConnectionRetainedThreadLoaded()).resolves.toEqual(
        firstThread,
      );
      expect(persistence.load).toHaveBeenCalledTimes(2);
      expect(retained.getBackgroundConnectionRetainedThreadSnapshot()).toEqual({
        loaded: true,
        thread: firstThread,
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("does not let a cold load replace a thread saved during startup", async () => {
    const coldLoad = deferred<typeof firstThread | null>();
    persistence.load.mockReturnValueOnce(coldLoad.promise);
    const retained = await import("./retained-thread");

    const loading = retained.ensureBackgroundConnectionRetainedThreadLoaded();
    const saving = retained.saveBackgroundConnectionRetainedThread(secondThread);
    await Promise.resolve();
    expect(persistence.save).not.toHaveBeenCalled();
    coldLoad.resolve(firstThread);
    await Promise.all([loading, saving]);

    expect(retained.getBackgroundConnectionRetainedThreadSnapshot()).toEqual({
      loaded: true,
      thread: secondThread,
    });
  });

  it("persists rapid thread changes in invocation order", async () => {
    const firstWrite = deferred<void>();
    persistence.save.mockReturnValueOnce(firstWrite.promise).mockResolvedValueOnce(undefined);
    const retained = await import("./retained-thread");

    const savingFirst = retained.saveBackgroundConnectionRetainedThread(firstThread);
    const savingSecond = retained.saveBackgroundConnectionRetainedThread(secondThread);
    await Promise.resolve();

    expect(persistence.save).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await Promise.all([savingFirst, savingSecond]);
    expect(persistence.save.mock.calls.map(([thread]) => thread)).toEqual([
      firstThread,
      secondThread,
    ]);
  });

  it("does not let a slow save overwrite a later clear", async () => {
    const slowSave = deferred<void>();
    persistence.save.mockReturnValueOnce(slowSave.promise);
    const retained = await import("./retained-thread");

    const saving = retained.saveBackgroundConnectionRetainedThread(firstThread);
    const clearing = retained.clearBackgroundConnectionRetainedThread();
    await Promise.resolve();

    expect(persistence.save).toHaveBeenCalledOnce();
    expect(persistence.clear).not.toHaveBeenCalled();
    slowSave.resolve();
    await Promise.all([saving, clearing]);
    expect(persistence.clear).toHaveBeenCalledOnce();
    expect(retained.getBackgroundConnectionRetainedThreadSnapshot().thread).toBeNull();
  });
});
