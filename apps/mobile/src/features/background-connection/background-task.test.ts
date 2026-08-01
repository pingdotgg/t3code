import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  acquireRoot: vi.fn(() => vi.fn()),
  acquireOutbox: vi.fn(() => vi.fn()),
  relayStop: vi.fn(),
  setRuntimeReady: vi.fn(),
  acknowledgeStop: vi.fn(),
  enabled: true,
  firstAttempt: Promise.resolve(),
  stopListener: null as (() => void) | null,
  removeStopListener: vi.fn(),
}));

vi.mock("../cloud/backgroundManagedRelayAuth", () => ({
  startBackgroundManagedRelayAuth: () => ({
    firstAttempt: mocks.firstAttempt,
    retryNow: vi.fn(),
    stop: mocks.relayStop,
  }),
}));
vi.mock("../../native/backgroundConnection", () => ({
  addBackgroundConnectionStopRequestListener: (listener: () => void) => {
    mocks.stopListener = listener;
    return { remove: mocks.removeStopListener };
  },
  getBackgroundConnectionStatus: () => ({ enabled: mocks.enabled }),
  setBackgroundConnectionRuntimeReady: mocks.setRuntimeReady,
  acknowledgeBackgroundConnectionStop: mocks.acknowledgeStop,
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/use-thread-outbox-drain", () => ({
  acquireThreadOutboxDrain: mocks.acquireOutbox,
}));
vi.mock("./background-root", () => ({
  acquireBackgroundConnectionRoot: mocks.acquireRoot,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.enabled = true;
  mocks.firstAttempt = Promise.resolve();
  mocks.stopListener = null;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

it("shares one runtime across duplicate native task starts and cleans it up once", async () => {
  const { runBackgroundConnectionHeadlessTask } = await import("./background-task");

  const first = runBackgroundConnectionHeadlessTask();
  const second = runBackgroundConnectionHeadlessTask();
  expect(first).toBe(second);
  await vi.waitFor(() => {
    expect(mocks.acquireRoot).toHaveBeenCalledOnce();
    expect(mocks.acquireOutbox).toHaveBeenCalledOnce();
    expect(mocks.setRuntimeReady).toHaveBeenCalledWith(true);
  });

  mocks.stopListener?.();
  await Promise.all([first, second]);

  expect(mocks.acquireRoot.mock.results[0]?.value).toHaveBeenCalledOnce();
  expect(mocks.acquireOutbox.mock.results[0]?.value).toHaveBeenCalledOnce();
  expect(mocks.relayStop).toHaveBeenCalledOnce();
  expect(mocks.removeStopListener).toHaveBeenCalledOnce();
  expect(mocks.setRuntimeReady).toHaveBeenLastCalledWith(false);
  expect(mocks.acknowledgeStop).toHaveBeenCalledOnce();
});

it("cleans up a task that finishes loading after the feature was disabled", async () => {
  mocks.enabled = false;
  const { runBackgroundConnectionHeadlessTask } = await import("./background-task");

  await runBackgroundConnectionHeadlessTask();

  expect(mocks.acquireRoot).not.toHaveBeenCalled();
  expect(mocks.acquireOutbox).not.toHaveBeenCalled();
  expect(mocks.setRuntimeReady).not.toHaveBeenCalledWith(true);
  expect(mocks.relayStop).not.toHaveBeenCalled();
  expect(mocks.removeStopListener).toHaveBeenCalledOnce();
  expect(mocks.setRuntimeReady).toHaveBeenLastCalledWith(false);
  expect(mocks.acknowledgeStop).toHaveBeenCalledOnce();
});

it("marks direct connections ready and stops promptly while relay auth is loading", async () => {
  const authBootstrap = deferred();
  mocks.firstAttempt = authBootstrap.promise;
  const { runBackgroundConnectionHeadlessTask } = await import("./background-task");

  const task = runBackgroundConnectionHeadlessTask();
  await vi.waitFor(() => {
    expect(mocks.acquireRoot).toHaveBeenCalledOnce();
    expect(mocks.acquireOutbox).toHaveBeenCalledOnce();
    expect(mocks.setRuntimeReady).toHaveBeenCalledWith(true);
  });

  mocks.stopListener?.();
  await task;

  expect(mocks.setRuntimeReady).toHaveBeenCalledWith(true);
  expect(mocks.acquireRoot.mock.results[0]?.value).toHaveBeenCalledOnce();
  expect(mocks.acquireOutbox.mock.results[0]?.value).toHaveBeenCalledOnce();
  expect(mocks.relayStop).toHaveBeenCalledOnce();
  expect(mocks.acknowledgeStop).toHaveBeenCalledOnce();

  authBootstrap.resolve();
});
