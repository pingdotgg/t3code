import { act, createRef, useContext, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import {
  ThreadFind,
  ThreadFindProvider,
  ThreadFindTimelineContext,
  type ThreadFindControls,
} from "./ThreadFindProvider";
import type { ThreadFindBar } from "./ThreadFindBar";

const query = vi.hoisted(() => ({
  value: {
    data: null as OrchestrationV2SearchThreadResult | null,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  },
  listeners: new Set<() => void>(),
}));
let bar: Parameters<typeof ThreadFindBar>[0];
vi.mock("./ThreadFindBar", () => ({
  ThreadFindBar: (props: typeof bar) => {
    bar = props;
    return null;
  },
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { threadFind: (target: unknown) => target },
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: <T,>(value: T) => value }));
vi.mock("~/state/query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentQuery: (atom: unknown) => {
      const value = useSyncExternalStore(
        (listener) => {
          query.listeners.add(listener);
          return () => query.listeners.delete(listener);
        },
        () => query.value,
      );
      return { ...value, data: atom ? value.data : null };
    },
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  query.listeners.clear();
  vi.unstubAllGlobals();
});

it("keeps navigation and pending responses out of the surrounding chat and unrelated children", async () => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const controls = createRef<ThreadFindControls>();
  const parentRender = vi.fn();
  const composerRender = vi.fn();
  const timelineRender = vi.fn();
  function Composer() {
    composerRender();
    return null;
  }
  function Timeline() {
    timelineRender(useContext(ThreadFindTimelineContext));
    return null;
  }
  function Chat() {
    parentRender();
    const [, setOpen] = useState(false);
    return (
      <ThreadFindProvider
        thread={{ environmentId: EnvironmentId.make("dev"), threadId: ThreadId.make("thread") }}
        enabled
        content={undefined}
        controlsRef={controls}
        onOpenChange={setOpen}
      >
        <ThreadFind onClose={() => {}} />
        <Timeline />
        <Composer />
      </ThreadFindProvider>
    );
  }
  const response = (index: number): OrchestrationV2SearchThreadResult => ({
    totalMatches: 3,
    activeIndex: index,
    snapshotSequence: 1,
    match: { entryId: "message", runId: null, occurrence: index },
  });
  query.value = { ...query.value, data: response(0), isPending: false };
  await act(async () => {
    renderer = create(<Chat />);
  });
  await act(async () => controls.current?.open());
  await act(async () => bar.onQueryChange("COD4"));
  const parentCount = parentRender.mock.calls.length;
  const composerCount = composerRender.mock.calls.length;
  const timelineCount = timelineRender.mock.calls.length;
  await act(async () => {
    query.value = { ...query.value, data: null, isPending: true };
    for (const listener of query.listeners) listener();
    bar.onNext();
  });
  expect(parentRender).toHaveBeenCalledTimes(parentCount);
  expect(composerRender).toHaveBeenCalledTimes(composerCount);
  expect(timelineRender).toHaveBeenCalledTimes(timelineCount);
  await act(async () => {
    query.value = { ...query.value, data: response(1), isPending: false };
    for (const listener of query.listeners) listener();
  });
  expect(parentRender).toHaveBeenCalledTimes(parentCount);
  expect(composerRender).toHaveBeenCalledTimes(composerCount);
  expect(timelineRender).toHaveBeenCalledTimes(timelineCount + 1);
  expect(timelineRender.mock.lastCall?.[0]?.activeFindMatch?.occurrence).toBe(1);
  await act(async () => controls.current?.close());
  expect(parentRender.mock.calls.length).toBeGreaterThan(parentCount);
});
