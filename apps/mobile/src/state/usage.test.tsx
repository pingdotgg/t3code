import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  statuses: [] as readonly {
    environmentId: string;
    label: string;
    isPending: boolean;
    error: string | null;
    summary: null;
  }[],
  refreshUsageSummary: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.statuses }));
vi.mock("./presentation", () => ({ presentationsAtom: {} }));
vi.mock("./server", () => ({ serverEnvironment: { usageSummary: {}, refreshUsageSummary: {} } }));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: () => mocks.refreshUsageSummary,
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
      { environmentId: "env-1", label: "Local", isPending: false, error: null, summary: null },
    ];
    mocks.refreshUsageSummary.mockReset();
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
});
