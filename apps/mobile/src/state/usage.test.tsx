import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  statuses: [] as readonly {
    environmentId: string;
    label: string;
    isPending: boolean;
    error: string | null;
    summary: UsageSummary | null;
  }[],
  refreshSummaryCommand: {},
  refreshRatesCommand: {},
  refreshUsageSummary: vi.fn(),
  refreshUsageRates: vi.fn(),
  getAtom: vi.fn(() => ({ waiting: false })),
  usageSummary: vi.fn((_request: { environmentId: string; input: UsageSummaryInput }) => ({})),
  executeAtomQuery: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.statuses }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "refresh-attempt" }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: { get: mocks.getAtom } }));
vi.mock("./presentation", () => ({ presentationsAtom: {} }));
vi.mock("./server", () => ({
  serverEnvironment: {
    usageSummary: mocks.usageSummary,
    refreshUsageSummary: mocks.refreshSummaryCommand,
    refreshUsageRates: mocks.refreshRatesCommand,
  },
}));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: object) =>
    command === mocks.refreshRatesCommand ? mocks.refreshUsageRates : mocks.refreshUsageSummary,
}));
import { useUsage, type UsageView } from "./usage";

const WINDOW_A: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-31"),
  timeZone: "UTC",
  resolution: "day",
};
const WINDOW_B: UsageSummaryInput = {
  ...WINDOW_A,
  sinceDay: UsageDay.make("2026-08-02"),
  untilDay: UsageDay.make("2026-09-01"),
};
const SUMMARY: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-31T12:00:00.000Z",
  timeZone: "UTC",
  sinceDay: WINDOW_A.sinceDay,
  untilDay: WINDOW_A.untilDay,
  buckets: [],
  sources: [],
  pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
  coverage: {
    availableThroughDay: WINDOW_A.untilDay,
    availableThroughTime: null,
    generatedAt: "2026-08-31T12:00:00.000Z",
  },
  scanDurationMs: 0,
};

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function Harness({
  input,
  onView,
}: {
  input: UsageSummaryInput;
  onView: (view: UsageView) => void;
}) {
  onView(useUsage(input));
  return null;
}

async function renderHarness(input: UsageSummaryInput, onView: (view: UsageView) => void) {
  const document = installTestDom();
  // The mobile app does not ship react-dom types, but the lightweight host
  // renderer keeps this hook test independent from a native runtime.
  // @ts-expect-error react-dom is only used by this test harness.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.createElement("div") as unknown as Element);
  await act(() => root.render(createElement(Harness, { input, onView })));
  return root;
}

describe("mobile useUsage boundary refresh", () => {
  beforeEach(() => {
    mocks.statuses = [
      { environmentId: "env-1", label: "Local", isPending: false, error: null, summary: SUMMARY },
    ];
    mocks.refreshUsageSummary.mockReset();
    mocks.refreshUsageRates.mockReset();
    mocks.refreshUsageRates.mockResolvedValue({ _tag: "Success" });
    mocks.getAtom.mockReset();
    mocks.getAtom.mockReturnValue({ waiting: false });
    mocks.usageSummary.mockClear();
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success" });
  });

  it.each([
    ["success", null],
    ["failure", "Refresh failed. Showing the last successful usage snapshot."],
  ] as const)(
    "keeps a boundary refresh visible through the committed window (%s)",
    async (_, error) => {
      const pending = deferred<{ _tag: "Success" | "Failure" }>();
      mocks.refreshUsageSummary.mockReturnValue(pending.promise);
      let view!: UsageView;
      const root = await renderHarness(WINDOW_A, (nextView) => {
        view = nextView;
      });

      try {
        await act(() => {
          view.refresh(WINDOW_B);
          root.render(
            createElement(Harness, { input: WINDOW_B, onView: (nextView) => (view = nextView) }),
          );
        });
        expect(view.isRefreshing).toBe(true);

        await act(async () => {
          pending.resolve({ _tag: error === null ? "Success" : "Failure" });
          await pending.promise;
        });
        expect(view.isRefreshing).toBe(false);
        expect(view.refreshError).toBe(error);
      } finally {
        await act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("waits for the subscribed rebased query to publish a successful legacy refresh", async () => {
    const stale = deferred<{ _tag: "Success" | "Failure" }>();
    const published = deferred<{ _tag: "Success" | "Failure" }>();
    mocks.statuses = [
      {
        environmentId: "env-1",
        label: "Local",
        isPending: false,
        error: null,
        summary: { ...SUMMARY, contractVersion: 12 } as UsageSummary,
      },
    ];
    mocks.getAtom.mockReturnValue({ waiting: true });
    mocks.executeAtomQuery
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(published.promise);
    let view!: UsageView;
    const root = await renderHarness(WINDOW_A, (nextView) => {
      view = nextView;
    });

    try {
      await act(async () => {
        view.refresh(WINDOW_B);
        root.render(
          createElement(Harness, { input: WINDOW_B, onView: (nextView) => (view = nextView) }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.executeAtomQuery).toHaveBeenCalledTimes(2);
      const tokenInput = mocks.usageSummary.mock.calls[0]?.[0]?.input;
      expect(tokenInput).toEqual({
        ...WINDOW_B,
        refreshToken: expect.any(String),
      });
      if (tokenInput?.refreshToken === undefined) throw new Error("missing refresh token");
      expect(JSON.parse(tokenInput.refreshToken)).toEqual([expect.any(String), "refresh-attempt"]);
      expect(mocks.usageSummary).toHaveBeenNthCalledWith(2, {
        environmentId: "env-1",
        input: WINDOW_B,
      });
      expect(view.isRefreshing).toBe(true);

      await act(async () => {
        stale.resolve({ _tag: "Success" });
        await stale.promise;
      });
      expect(mocks.executeAtomQuery).toHaveBeenCalledTimes(3);
      expect(mocks.executeAtomQuery).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.anything(),
        { reportFailure: false },
      );
      expect(mocks.executeAtomQuery).toHaveBeenNthCalledWith(
        3,
        expect.anything(),
        expect.anything(),
        { reportFailure: false, refresh: true },
      );
      expect(view.isRefreshing).toBe(true);

      await act(async () => {
        published.resolve({ _tag: "Success" });
        await published.promise;
      });
      expect(view.isRefreshing).toBe(false);
      expect(view.refreshError).toBeNull();
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("waits for a rebased failed legacy fallback query before completing refresh", async () => {
    const fallback = deferred<{ _tag: "Success" | "Failure" }>();
    mocks.statuses = [
      {
        environmentId: "env-1",
        label: "Local",
        isPending: false,
        error: "This environment could not report usage.",
        summary: null,
      },
    ];
    mocks.executeAtomQuery.mockReturnValue(fallback.promise);
    let view!: UsageView;
    const root = await renderHarness(WINDOW_A, (nextView) => {
      view = nextView;
    });

    try {
      await act(async () => {
        view.refresh(WINDOW_B);
        root.render(
          createElement(Harness, { input: WINDOW_B, onView: (nextView) => (view = nextView) }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.refreshUsageSummary).not.toHaveBeenCalled();
      expect(mocks.executeAtomQuery).toHaveBeenCalledOnce();
      expect(mocks.usageSummary).toHaveBeenCalledWith({
        environmentId: "env-1",
        input: {
          ...WINDOW_B,
          refreshToken: JSON.stringify(["unknown", "refresh-attempt"]),
        },
      });
      expect(view.isRefreshing).toBe(true);

      await act(async () => {
        fallback.resolve({ _tag: "Failure" });
        await fallback.promise;
      });
      expect(view.isRefreshing).toBe(false);
      expect(view.refreshError).toBe("Refresh failed. Showing the last successful usage snapshot.");
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
