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
  runAtomCommand: vi.fn(),
  getAtom: vi.fn(() => ({ waiting: false })),
  usageSummary: vi.fn((_request: { environmentId: string; input: UsageSummaryInput }) => ({})),
  executeAtomQuery: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.statuses }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "refresh-attempt" }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: { get: mocks.getAtom } }));
vi.mock("./presentation", () => ({ presentationsAtom: {} }));
vi.mock("./server", () => ({
  serverEnvironment: {
    usageSummary: mocks.usageSummary,
    refreshUsageRates: {},
  },
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

describe("mobile useUsage requested-window refresh", () => {
  beforeEach(() => {
    mocks.statuses = [
      { environmentId: "env-1", label: "Local", isPending: false, error: null, summary: SUMMARY },
    ];
    mocks.runAtomCommand.mockReset();
    mocks.getAtom.mockReset();
    mocks.getAtom.mockReturnValue({ waiting: false });
    mocks.usageSummary.mockClear();
    mocks.executeAtomQuery.mockReset();
  });

  it("awaits the token scan and target-window publication before completing", async () => {
    const rates = deferred<{ _tag: "Success" | "Failure" }>();
    const published = deferred<{ _tag: "Success" | "Failure" }>();
    mocks.runAtomCommand.mockReturnValue(rates.promise);
    mocks.executeAtomQuery
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockReturnValueOnce(published.promise);
    let view!: UsageView;
    const root = await renderHarness(WINDOW_A, (nextView) => {
      view = nextView;
    });

    try {
      let completed = false;
      const refresh = view.refresh(WINDOW_B).then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(mocks.executeAtomQuery).not.toHaveBeenCalled();
      expect(completed).toBe(false);

      rates.resolve({ _tag: "Success" });
      await rates.promise;
      await Promise.resolve();
      await Promise.resolve();

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
      expect(completed).toBe(false);

      published.resolve({ _tag: "Success" });
      await refresh;
      expect(completed).toBe(true);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("rejects a failed retry without waiting on an environment still doing its initial read", async () => {
    const failure = new Error("transcript scan failed");
    mocks.statuses = [
      {
        environmentId: "failed",
        label: "Failed",
        isPending: false,
        error: "This environment could not report usage.",
        summary: null,
      },
      {
        environmentId: "initial",
        label: "Initial",
        isPending: true,
        error: null,
        summary: null,
      },
    ];
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Success" });
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Failure", cause: failure });
    let view!: UsageView;
    const root = await renderHarness(WINDOW_A, (nextView) => {
      view = nextView;
    });

    try {
      await expect(view.refresh(WINDOW_B)).rejects.toBe(failure);
      expect(mocks.runAtomCommand).toHaveBeenCalledOnce();
      expect(mocks.runAtomCommand.mock.calls[0]?.[2]).toEqual({
        environmentId: "failed",
        input: {},
      });
      expect(mocks.usageSummary).toHaveBeenCalledOnce();
      expect(mocks.usageSummary.mock.calls[0]?.[0]).toEqual({
        environmentId: "failed",
        input: {
          ...WINDOW_B,
          refreshToken: JSON.stringify(["unknown", "refresh-attempt"]),
        },
      });
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
