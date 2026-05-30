// @effect-diagnostics nodeBuiltinImport:off - Service worker tests execute browser worker assets in a Node VM.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://t3.example";
const TARGET_URL = `${ORIGIN}/env-1/thread-1`;
const HOME_URL = `${ORIGIN}/`;
const CROSS_ORIGIN_URL = "https://elsewhere.example/env-1/thread-1";
const DEFAULT_NOTIFICATION_TITLE = "Salchi";

interface MockClientState {
  readonly url: string;
  readonly focusCalls: number;
  readonly navigateCalls: string[];
  readonly postMessageCalls: Array<{
    readonly type: string;
    readonly url: string;
    readonly openedAt: number;
  }>;
}

interface ServiceWorkerTestHarness {
  readonly context: vm.Context;
  readonly openWindowCalls: string[];
  readonly getClients: () => MockClientState[];
  readonly addClient: (options: {
    readonly url: string;
    readonly focused?: boolean;
    readonly visibilityState?: "hidden" | "visible";
    readonly navigate?: ReturnType<typeof vi.fn>;
  }) => void;
}

function createServiceWorkerTestHarness(): ServiceWorkerTestHarness {
  const openWindowCalls: string[] = [];
  const context: Record<string, unknown> = {
    URL,
    console,
    __windowClients: [] as Array<Record<string, unknown>>,
    self: {
      location: { origin: ORIGIN, href: `${ORIGIN}/` },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      skipWaiting: vi.fn(),
      clients: {
        matchAll: async () => context.__windowClients,
        openWindow: async (url: string) => {
          openWindowCalls.push(url);
        },
      },
    },
  };

  const serviceWorkerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../public/t3-service-worker.js",
  );
  const source = readFileSync(serviceWorkerPath, "utf8");

  vm.createContext(context);
  vm.runInContext(
    `${source}
this.__t3ServiceWorkerTestExports = {
  notificationTitle,
  openNotificationUrl,
};`,
    context,
  );

  return {
    context,
    openWindowCalls,
    getClients: () =>
      (context.__windowClients as Array<Record<string, unknown>>).map((client) => ({
        url: String(client.url),
        focusCalls: Number(client.focusCalls ?? 0),
        navigateCalls: (client.navigateCalls as string[] | undefined) ?? [],
        postMessageCalls:
          (client.postMessageCalls as MockClientState["postMessageCalls"] | undefined) ?? [],
      })),
    addClient: (options) => {
      const navigateBody =
        options.navigate === undefined
          ? ""
          : `async navigate(url) {
    this.navigateCalls.push(url);
    return typeof navigateImpl === "function" ? navigateImpl(url) : undefined;
  },`;
      vm.runInContext(
        `
{
const navigateImpl = ${options.navigate ? options.navigate.toString() : "undefined"};
__windowClients.push({
  url: ${JSON.stringify(options.url)},
  focused: ${options.focused === true},
  visibilityState: ${JSON.stringify(options.visibilityState ?? "visible")},
  focusCalls: 0,
  navigateCalls: [],
  postMessageCalls: [],
  async focus() {
    this.focusCalls += 1;
    return this;
  },
  ${navigateBody}
  postMessage(message) {
    this.postMessageCalls.push(message);
  },
});
}`,
        context,
      );
    },
  };
}

async function openNotificationUrl(harness: ServiceWorkerTestHarness, url: string): Promise<void> {
  await vm.runInContext(
    `__t3ServiceWorkerTestExports.openNotificationUrl(${JSON.stringify(url)})`,
    harness.context,
  );
}

function notificationTitle(harness: ServiceWorkerTestHarness, rawTitle: unknown): string {
  return String(
    vm.runInContext(
      `__t3ServiceWorkerTestExports.notificationTitle(${JSON.stringify(rawTitle)})`,
      harness.context,
    ),
  );
}

describe("t3-service-worker notification click navigation", () => {
  let harness: ServiceWorkerTestHarness;

  beforeEach(() => {
    harness = createServiceWorkerTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips the app source suffix from notification titles", () => {
    expect(notificationTitle(harness, "Investigate deploy from Salchi")).toBe("Investigate deploy");
    expect(notificationTitle(harness, "Investigate deploy")).toBe("Investigate deploy");
    expect(notificationTitle(harness, "from Salchi")).toBe(DEFAULT_NOTIFICATION_TITLE);
  });

  it("opens a new window with the full URL when no same-origin client exists", async () => {
    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
  });

  it("ignores cross-origin clients when deciding whether the app is open", async () => {
    harness.addClient({ url: CROSS_ORIGIN_URL, focused: true });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(0);
    expect(client?.postMessageCalls).toEqual([]);
    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
  });

  it("focuses an exact-url client without navigating", async () => {
    harness.addClient({ url: TARGET_URL, focused: true });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("treats trailing-slash variants as an exact-url match", async () => {
    harness.addClient({ url: `${TARGET_URL}/`, focused: true });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.postMessageCalls).toHaveLength(1);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses and postMessages a different same-origin client without navigating", async () => {
    harness.addClient({
      url: HOME_URL,
      focused: true,
      navigate: vi.fn(),
    });

    await openNotificationUrl(harness, TARGET_URL);

    const client = harness.getClients().find((entry) => entry.url === HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses and postMessages a hidden same-origin client without opening a new window", async () => {
    harness.addClient({
      url: HOME_URL,
      visibilityState: "hidden",
      navigate: vi.fn(),
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("selects the exact target URL before a focused same-origin client", async () => {
    harness.addClient({
      url: HOME_URL,
      focused: true,
      navigate: vi.fn(),
    });
    harness.addClient({
      url: TARGET_URL,
      focused: false,
      navigate: vi.fn(),
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [homeClient, targetClient] = harness.getClients();
    expect(homeClient?.focusCalls).toBe(0);
    expect(homeClient?.postMessageCalls).toEqual([]);
    expect(targetClient?.focusCalls).toBe(1);
    expect(targetClient?.navigateCalls).toEqual([]);
    expect(targetClient?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });
});
