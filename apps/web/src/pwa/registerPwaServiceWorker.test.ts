import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerPwaServiceWorker } from "./registerPwaServiceWorker";
import { usePwaServiceWorkerUpdateStore } from "./serviceWorkerUpdateState";

type RegisterSWOptions = {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onRegisteredSW?: (
    swScriptUrl: string,
    registration: ServiceWorkerRegistration | undefined,
  ) => void;
};

type BrowserEnvironment = {
  dispatchVisibilityChange: () => void;
  intervalHandlers: Array<() => void>;
};

type FakeServiceWorker = ServiceWorker & {
  getStateChangeListenerCount: () => number;
  setState: (state: ServiceWorkerState) => void;
};

const registerSWMock = vi.hoisted(() => vi.fn());

vi.mock("virtual:pwa-register", () => ({
  registerSW: registerSWMock,
}));

function resetUpdateStore(): void {
  usePwaServiceWorkerUpdateStore.setState(usePwaServiceWorkerUpdateStore.getInitialState(), true);
}

function createDeferred(): {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function installBrowserEnvironment(options: { online?: boolean } = {}): BrowserEnvironment {
  const intervalHandlers: Array<() => void> = [];
  const visibilityChangeListeners: EventListener[] = [];

  vi.stubGlobal("window", {
    isSecureContext: true,
    setInterval: vi.fn((handler: TimerHandler) => {
      if (typeof handler === "function") {
        intervalHandlers.push(handler as () => void);
      }
      return intervalHandlers.length;
    }),
    setTimeout: ((handler: TimerHandler, timeout?: number) =>
      globalThis.setTimeout(handler, timeout) as unknown as number) as Window["setTimeout"],
    clearTimeout: ((timerId?: number) => {
      globalThis.clearTimeout(timerId);
    }) as Window["clearTimeout"],
  });
  vi.stubGlobal("navigator", {
    onLine: options.online ?? true,
    serviceWorker: {},
  });
  vi.stubGlobal("document", {
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== "visibilitychange") {
        return;
      }
      if (typeof listener === "function") {
        visibilityChangeListeners.push(listener);
      } else {
        visibilityChangeListeners.push((event) => listener.handleEvent(event));
      }
    }),
    visibilityState: "visible",
  });

  return {
    dispatchVisibilityChange: () => {
      for (const listener of visibilityChangeListeners) {
        listener({ type: "visibilitychange" } as Event);
      }
    },
    intervalHandlers,
  };
}

function createInstallingServiceWorker(initialState: ServiceWorkerState = "installing") {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const worker = {
    state: initialState,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "statechange") {
        listeners.add(listener);
      }
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "statechange") {
        listeners.delete(listener);
      }
    }),
    getStateChangeListenerCount: () => listeners.size,
    setState: (state: ServiceWorkerState) => {
      worker.state = state;
      for (const listener of listeners) {
        const event = { type: "statechange" } as Event;
        if (typeof listener === "function") {
          listener.call(worker as unknown as ServiceWorker, event);
        } else {
          listener.handleEvent(event);
        }
      }
    },
  };

  return worker as unknown as FakeServiceWorker;
}

function createRegistration(
  update: () => Promise<void> = () => Promise.resolve(),
  installing: ServiceWorker | null = null,
  active: Pick<ServiceWorker, "postMessage"> | null = null,
): ServiceWorkerRegistration & {
  active: Pick<ServiceWorker, "postMessage"> | null;
  installing: ServiceWorker | null;
} {
  return { active, installing, update: vi.fn(update) } as unknown as ServiceWorkerRegistration & {
    active: Pick<ServiceWorker, "postMessage"> | null;
    installing: ServiceWorker | null;
  };
}

function readRegisterSWOptions(): RegisterSWOptions {
  const options = registerSWMock.mock.calls[0]?.[0] as RegisterSWOptions | undefined;
  if (!options) {
    throw new Error("registerSW was not called.");
  }
  return options;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("registerPwaServiceWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    registerSWMock.mockReset();
    registerSWMock.mockReturnValue(vi.fn(async () => {}));
    resetUpdateStore();
  });

  afterEach(() => {
    resetUpdateStore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("checks for updates immediately after production service worker registration", async () => {
    installBrowserEnvironment();
    const registration = createRegistration();

    registerPwaServiceWorker();
    const registerOptions = readRegisterSWOptions();
    expect(registerOptions.immediate).toBe(true);

    registerOptions.onRegisteredSW?.("/t3-service-worker.js", registration);

    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(usePwaServiceWorkerUpdateStore.getState().checkPhase).toBe("checking");

    await flushMicrotasks();

    expect(usePwaServiceWorkerUpdateStore.getState().checkPhase).toBe("idle");
  });

  it("asks the active service worker to clear completed-turn alerts on registration and visibility", async () => {
    const browserEnvironment = installBrowserEnvironment();
    const postMessage = vi.fn();
    const registration = createRegistration(() => Promise.resolve(), null, { postMessage });

    registerPwaServiceWorker();
    readRegisterSWOptions().onRegisteredSW?.("/t3-service-worker.js", registration);

    expect(postMessage).toHaveBeenCalledWith({
      type: "t3.clear-turn-completion-notifications",
    });
    postMessage.mockClear();

    browserEnvironment.dispatchVisibilityChange();

    expect(postMessage).toHaveBeenCalledWith({
      type: "t3.clear-turn-completion-notifications",
    });
  });

  it("skips the startup update check while offline", () => {
    installBrowserEnvironment({ online: false });
    const registration = createRegistration();

    registerPwaServiceWorker();
    readRegisterSWOptions().onRegisteredSW?.("/t3-service-worker.js", registration);

    expect(registration.update).not.toHaveBeenCalled();
    expect(usePwaServiceWorkerUpdateStore.getState().checkPhase).toBe("idle");
  });

  it("keeps visibility-change checks wired and coalesces them while a check is in flight", async () => {
    const browserEnvironment = installBrowserEnvironment();
    const startupUpdate = createDeferred();
    const registration = createRegistration(
      vi.fn().mockReturnValueOnce(startupUpdate.promise).mockResolvedValue(undefined),
    );

    registerPwaServiceWorker();
    readRegisterSWOptions().onRegisteredSW?.("/t3-service-worker.js", registration);

    expect(browserEnvironment.intervalHandlers).toHaveLength(1);
    expect(registration.update).toHaveBeenCalledTimes(1);

    browserEnvironment.dispatchVisibilityChange();

    expect(registration.update).toHaveBeenCalledTimes(1);

    startupUpdate.resolve();
    await flushMicrotasks();

    browserEnvironment.dispatchVisibilityChange();

    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("marks a waiting update as ready even when an update check is visible", () => {
    installBrowserEnvironment();
    const startupUpdate = createDeferred();
    const updateServiceWorker = vi.fn(async () => {});
    const registration = createRegistration(() => startupUpdate.promise);
    registerSWMock.mockReturnValue(updateServiceWorker);

    registerPwaServiceWorker();
    const registerOptions = readRegisterSWOptions();
    registerOptions.onRegisteredSW?.("/t3-service-worker.js", registration);

    expect(usePwaServiceWorkerUpdateStore.getState().checkPhase).toBe("checking");

    registerOptions.onNeedRefresh?.();

    expect(usePwaServiceWorkerUpdateStore.getState()).toMatchObject({
      checkPhase: "checking",
      status: "ready",
      updateServiceWorker,
    });
  });

  it("keeps the update indicator visible while a found update installs", async () => {
    installBrowserEnvironment();
    const startupUpdate = createDeferred();
    const installingWorker = createInstallingServiceWorker();
    const updateServiceWorker = vi.fn(async () => {});
    const registration = createRegistration(() => startupUpdate.promise, installingWorker);
    registerSWMock.mockReturnValue(updateServiceWorker);

    registerPwaServiceWorker();
    const registerOptions = readRegisterSWOptions();
    registerOptions.onRegisteredSW?.("/t3-service-worker.js", registration);

    expect(usePwaServiceWorkerUpdateStore.getState()).toMatchObject({
      checkPhase: "checking",
      status: "idle",
    });

    startupUpdate.resolve();
    await flushMicrotasks();

    expect(usePwaServiceWorkerUpdateStore.getState()).toMatchObject({
      checkPhase: "downloading",
      status: "idle",
    });
    expect(installingWorker.getStateChangeListenerCount()).toBe(1);

    installingWorker.setState("installed");
    registerOptions.onNeedRefresh?.();
    await flushMicrotasks();

    expect(usePwaServiceWorkerUpdateStore.getState()).toMatchObject({
      checkPhase: "idle",
      status: "ready",
      updateServiceWorker,
    });
    expect(installingWorker.getStateChangeListenerCount()).toBe(0);
  });

  it("clears the update indicator when a found service worker install becomes redundant", async () => {
    installBrowserEnvironment();
    const startupUpdate = createDeferred();
    const installingWorker = createInstallingServiceWorker();
    const registration = createRegistration(() => startupUpdate.promise, installingWorker);

    registerPwaServiceWorker();
    readRegisterSWOptions().onRegisteredSW?.("/t3-service-worker.js", registration);

    startupUpdate.resolve();
    await flushMicrotasks();

    expect(usePwaServiceWorkerUpdateStore.getState().checkPhase).toBe("downloading");

    installingWorker.setState("redundant");
    await flushMicrotasks();

    expect(usePwaServiceWorkerUpdateStore.getState()).toMatchObject({
      checkPhase: "idle",
      status: "idle",
    });
    expect(installingWorker.getStateChangeListenerCount()).toBe(0);
  });

  it("times out a hung service worker install and allows a later fresh update check", async () => {
    const browserEnvironment = installBrowserEnvironment();
    const installingWorker = createInstallingServiceWorker();
    const registration = createRegistration(() => Promise.resolve(), installingWorker);

    registerPwaServiceWorker();
    readRegisterSWOptions().onRegisteredSW?.("/t3-service-worker.js", registration);

    await flushMicrotasks();

    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(usePwaServiceWorkerUpdateStore.getState().checkPhase).toBe("downloading");

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(usePwaServiceWorkerUpdateStore.getState().checkPhase).toBe("idle");
    expect(installingWorker.getStateChangeListenerCount()).toBe(0);

    registration.installing = null;
    browserEnvironment.dispatchVisibilityChange();

    expect(registration.update).toHaveBeenCalledTimes(2);
  });
});
