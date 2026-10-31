import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { threadListInboxReturns } from "./threadListV2";
import { useThreadListV2 } from "./useThreadListV2";

// The real shelf reads the app's atom registry, which imports Expo; this list has no older pages.
vi.mock("../../state/olderSettledShelf", () => ({
  useOlderSettledShelf: () => ({ isListed: () => true, unloadedCount: () => 0 }),
  useOlderSettledShelfGrowth: () => {},
}));

const NOW = "2026-06-02T00:00:00.000Z";
const environmentId = EnvironmentId.make("environment-1");

it("returns a thread from the Working shelf once its exit grace expires", async () => {
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  using _tracker = { [Symbol.dispose]: () => threadListInboxReturns.observe(null) };
  vi.useFakeTimers({ now: Date.parse(NOW) });
  const working = makeThreadShellFixture({
    environmentId,
    id: ThreadId.make("echo"),
    title: "echo",
    runtime: {
      status: "running",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: NOW,
    },
  });
  const completed = { ...working, runtime: null };
  const seen: Array<ReturnType<typeof useThreadListV2>["layout"]> = [];
  function Probe(props: { readonly threads: ReadonlyArray<typeof working> }) {
    const { layout } = useThreadListV2({
      threads: props.threads,
      pendingTasks: [],
      environmentId: null,
      projectRefs: null,
      searchQuery: "",
      searchMatches: new Map(),
      settlementEnvironmentIds: new Set(),
      snoozeEnvironmentIds: new Set(),
      pinReorderEnvironmentIds: new Set(),
      activeReorderEnvironmentIds: new Set(),
      queuedThreadKeys: new Set(),
      settledLimit: 10,
      now: NOW,
      pendingOrder: null,
      shelfPreferencesLoaded: true,
      workingShelfEnabled: true,
      workingShelfExpanded: false,
      snoozedShelfExpanded: false,
      settledShelfExpanded: false,
      selectedThreadKey: null,
    });
    useLayoutEffect(() => {
      seen.push(layout);
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () => root.render(<Probe threads={[working]} />));
  await act(async () => root.render(<Probe threads={[completed]} />));
  expect(seen.at(-1)?.workingCount).toBe(1);

  await act(async () => vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS));
  expect(threadListInboxReturns.isWorking(completed)).toBe(false);
  expect(seen.at(-1)?.workingCount, "the list still shows the finished thread as working").toBe(0);
  expect(seen.at(-1)?.items.map((item) => item.thread.id)).toEqual(["echo"]);
});
