import {
  EnvironmentId,
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
  refreshAtom: vi.fn(),
  getAtom: vi.fn(() => ({ waiting: false })),
  usageSummary: vi.fn((_request: { environmentId: string; input: UsageSummaryInput }) => ({})),
  usageThreadBreakdown: vi.fn((request: unknown) => request),
  executeAtomQuery: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.statuses }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
}));
vi.mock("../lib/utils", () => ({ randomUUID: () => "refresh-attempt" }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: mocks.getAtom, refresh: mocks.refreshAtom },
}));
vi.mock("./presentation", () => ({ presentationsAtom: {} }));
vi.mock("./server", () => ({
  serverEnvironment: {
    usageSummary: mocks.usageSummary,
    usageThreadBreakdown: mocks.usageThreadBreakdown,
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
  projectFilter,
  refreshThreads = false,
  selectedEnvironmentIds = null,
}: {
  input: UsageSummaryInput;
  onView: (view: UsageView) => void;
  projectFilter?: string | null;
  refreshThreads?: boolean;
  selectedEnvironmentIds?: ReadonlySet<EnvironmentId> | null;
}) {
  onView(useUsage(input, projectFilter, refreshThreads, selectedEnvironmentIds));
  return null;
}

async function renderHarness(
  input: UsageSummaryInput,
  onView: (view: UsageView) => void,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  projectFilter?: string | null,
  refreshThreads = false,
) {
  const document = installTestDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.createElement("div") as unknown as Element);
  await act(() =>
    root.render(
      createElement(Harness, {
        input,
        onView,
        projectFilter,
        refreshThreads,
        selectedEnvironmentIds,
      }),
    ),
  );
  return root;
}

function usageStatus(id: string, costUsd: number | null, hostId = id) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: costUsd === null,
    error: null,
    summary:
      costUsd === null
        ? null
        : ({
            ...SUMMARY,
            buckets: [
              {
                day: WINDOW_A.sinceDay,
                provider: "codex",
                model: id,
                totals: {
                  uncachedInputTokens: 100,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 50,
                  reasoningTokens: 0,
                },
                costUsd,
                cacheSavingsUsd: 0,
                costSource: "modelPriced",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId,
                  provider: "codex",
                  resolvedHomePath: "/sessions",
                  volumeId: hostId,
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
          } satisfies UsageSummary),
  };
}

describe("web useUsage boundary refresh", () => {
  beforeEach(() => {
    mocks.statuses = [
      { environmentId: "env-1", label: "Local", isPending: false, error: null, summary: SUMMARY },
    ];
    mocks.refreshUsageSummary.mockReset();
    mocks.refreshUsageRates.mockReset();
    mocks.refreshUsageRates.mockResolvedValue({ _tag: "Success" });
    mocks.refreshAtom.mockReset();
    mocks.getAtom.mockReset();
    mocks.getAtom.mockReturnValue({ waiting: false });
    mocks.usageSummary.mockClear();
    mocks.usageThreadBreakdown.mockClear();
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

  it.each([
    [12, 0, 2],
    [13, 1, 0],
  ] as const)(
    "uses the explicit refresh RPC only for a v%s server",
    async (version, calls, fallbacks) => {
      mocks.statuses = [
        {
          environmentId: "env-1",
          label: "Local",
          isPending: false,
          error: null,
          summary: { ...SUMMARY, contractVersion: version } as UsageSummary,
        },
      ];
      mocks.refreshUsageSummary.mockResolvedValue({ _tag: "Success" });
      let view!: UsageView;
      const root = await renderHarness(WINDOW_A, (nextView) => {
        view = nextView;
      });

      try {
        await act(async () => {
          view.refresh();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mocks.refreshUsageRates).toHaveBeenCalledOnce();
        expect(mocks.refreshUsageSummary).toHaveBeenCalledTimes(calls);
        expect(mocks.executeAtomQuery).toHaveBeenCalledTimes(fallbacks);
        if (version === 12) {
          const tokenInput = mocks.usageSummary.mock.calls[0]?.[0]?.input;
          expect(tokenInput).toEqual({
            ...WINDOW_A,
            refreshToken: expect.any(String),
          });
          if (tokenInput?.refreshToken === undefined) throw new Error("missing refresh token");
          expect(JSON.parse(tokenInput.refreshToken)).toEqual([
            expect.any(String),
            "refresh-attempt",
          ]);
          expect(mocks.usageSummary).toHaveBeenNthCalledWith(2, {
            environmentId: "env-1",
            input: WINDOW_A,
          });
        }
      } finally {
        await act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("waits for the subscribed base query to publish a successful legacy refresh", async () => {
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
    mocks.executeAtomQuery
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockReturnValueOnce(published.promise);
    let view!: UsageView;
    const root = await renderHarness(WINDOW_A, (nextView) => {
      view = nextView;
    });

    try {
      await act(async () => {
        view.refresh();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.executeAtomQuery).toHaveBeenCalledTimes(2);
      expect(mocks.usageSummary).toHaveBeenNthCalledWith(2, {
        environmentId: "env-1",
        input: WINDOW_A,
      });
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

  it("waits for a failed legacy fallback query before completing refresh", async () => {
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
        view.refresh();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.refreshUsageSummary).not.toHaveBeenCalled();
      expect(mocks.executeAtomQuery).toHaveBeenCalledOnce();
      expect(mocks.usageSummary).toHaveBeenCalledWith({
        environmentId: "env-1",
        input: {
          ...WINDOW_A,
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

describe("web usage environment selection", () => {
  beforeEach(() => {
    mocks.statuses = [usageStatus("a", 10), usageStatus("b", 20), usageStatus("slow", null)];
    mocks.refreshUsageSummary.mockReset();
    mocks.refreshUsageRates.mockReset();
    mocks.refreshUsageRates.mockResolvedValue({ _tag: "Success" });
    mocks.refreshAtom.mockReset();
    mocks.getAtom.mockReset();
    mocks.getAtom.mockReturnValue({ waiting: false });
    mocks.usageSummary.mockClear();
    mocks.usageThreadBreakdown.mockClear();
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success" });
  });

  it("merges only selected environments and refreshes that same selection", async () => {
    let view!: UsageView;
    const root = await renderHarness(WINDOW_A, (nextView) => {
      view = nextView;
    });

    try {
      expect(view.merged.costUsd).toBe(30);
      expect(view.isPartial).toBe(true);

      await act(() =>
        root.render(
          createElement(Harness, {
            input: WINDOW_A,
            selectedEnvironmentIds: new Set([EnvironmentId.make("b")]),
            onView: (nextView) => {
              view = nextView;
            },
          }),
        ),
      );
      expect(view.merged.costUsd).toBe(20);
      expect(view.selectedEnvironments.map((environment) => environment.environmentId)).toEqual([
        "b",
      ]);
      expect(view.isPartial).toBe(false);

      await act(async () => {
        view.refresh();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.refreshUsageRates).toHaveBeenCalledOnce();
      expect(mocks.refreshUsageRates.mock.calls[0]?.[0]).toMatchObject({ environmentId: "b" });
      expect(mocks.refreshUsageSummary).toHaveBeenCalledOnce();
      expect(mocks.refreshUsageSummary.mock.calls[0]?.[0]).toMatchObject({ environmentId: "b" });
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("refreshes a healthy environment before another environment's rates settle", async () => {
    const fastRates = deferred<{ _tag: "Success" | "Failure" }>();
    const slowRates = deferred<{ _tag: "Success" | "Failure" }>();
    mocks.statuses = [usageStatus("fast", 10), usageStatus("slow", 20)];
    mocks.refreshUsageRates.mockImplementation(({ environmentId }: { environmentId: string }) =>
      environmentId === "fast" ? fastRates.promise : slowRates.promise,
    );
    mocks.refreshUsageSummary.mockResolvedValue({ _tag: "Success" });
    let view!: UsageView;
    const root = await renderHarness(
      WINDOW_A,
      (nextView) => {
        view = nextView;
      },
      null,
      undefined,
      true,
    );

    try {
      await act(async () => {
        view.refresh();
        await Promise.resolve();
      });
      expect(mocks.refreshUsageRates).toHaveBeenCalledTimes(2);
      expect(mocks.refreshUsageSummary).not.toHaveBeenCalled();
      expect(mocks.refreshAtom).not.toHaveBeenCalled();
      expect(view.isRefreshing).toBe(true);

      await act(async () => {
        fastRates.resolve({ _tag: "Success" });
        await fastRates.promise;
        await Promise.resolve();
      });
      expect(mocks.refreshUsageSummary).toHaveBeenCalledOnce();
      expect(mocks.refreshUsageSummary.mock.calls[0]?.[0]).toMatchObject({
        environmentId: "fast",
      });
      expect(mocks.refreshAtom).toHaveBeenCalledOnce();
      expect(mocks.usageThreadBreakdown.mock.calls[0]?.[0]).toMatchObject({
        environmentId: "fast",
        input: expect.not.objectContaining({ refreshToken: expect.anything() }),
      });
      expect(view.isRefreshing).toBe(true);

      await act(async () => {
        slowRates.resolve({ _tag: "Success" });
        await slowRates.promise;
        await Promise.resolve();
      });
      expect(mocks.refreshUsageSummary).toHaveBeenCalledTimes(2);
      expect(mocks.refreshUsageSummary.mock.calls[1]?.[0]).toMatchObject({
        environmentId: "slow",
      });
      expect(mocks.refreshAtom).toHaveBeenCalledTimes(2);
      expect(mocks.usageThreadBreakdown.mock.calls[1]?.[0]).toMatchObject({
        environmentId: "slow",
        input: expect.not.objectContaining({ refreshToken: expect.anything() }),
      });
      expect(view.isRefreshing).toBe(false);
      expect(view.refreshError).toBeNull();
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates within the selection after excluding the original owner", async () => {
    mocks.statuses = [usageStatus("a", 10, "shared"), usageStatus("b", 20, "shared")];
    let view!: UsageView;
    const root = await renderHarness(WINDOW_A, (nextView) => {
      view = nextView;
    });

    try {
      expect(view.merged.costUsd).toBe(10);
      await act(() =>
        root.render(
          createElement(Harness, {
            input: WINDOW_A,
            selectedEnvironmentIds: new Set([EnvironmentId.make("b")]),
            onView: (nextView) => {
              view = nextView;
            },
          }),
        ),
      );
      expect(view.merged.costUsd).toBe(20);
      expect(view.merged.duplicateSources).toEqual([]);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("ignores background refreshes outside the selected project environment", async () => {
    mocks.statuses = [usageStatus("a", 10), { ...usageStatus("b", 20), isPending: true }];
    let view!: UsageView;
    const root = await renderHarness(
      WINDOW_A,
      (nextView) => {
        view = nextView;
      },
      null,
      JSON.stringify([EnvironmentId.make("a"), "id:project-a"]),
    );

    try {
      expect(view.isRefreshing).toBe(false);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("discards an old refresh failure after the environment selection changes", async () => {
    const pending = deferred<{ _tag: "Success" | "Failure" }>();
    mocks.statuses = [usageStatus("a", 10), usageStatus("b", 20)];
    mocks.refreshUsageSummary.mockReturnValue(pending.promise);
    let view!: UsageView;
    const selectedA = new Set([EnvironmentId.make("a")]);
    const root = await renderHarness(
      WINDOW_A,
      (nextView) => {
        view = nextView;
      },
      selectedA,
    );

    try {
      await act(() => view.refresh());
      expect(view.isRefreshing).toBe(true);

      await act(() =>
        root.render(
          createElement(Harness, {
            input: WINDOW_A,
            selectedEnvironmentIds: new Set([EnvironmentId.make("b")]),
            onView: (nextView) => {
              view = nextView;
            },
          }),
        ),
      );
      expect(view.isRefreshing).toBe(false);
      expect(view.refreshError).toBeNull();

      await act(async () => {
        pending.resolve({ _tag: "Failure" });
        await pending.promise;
      });
      expect(view.isRefreshing).toBe(false);
      expect(view.refreshError).toBeNull();
      expect(view.merged.costUsd).toBe(20);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
