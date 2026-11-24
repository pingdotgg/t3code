import { claimThreadOpen } from "@t3tools/client-runtime/state/thread-search";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  visitRun: vi.fn(),
}));

const shellKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: ((ref: ScopedThreadRef) => shellAtom(shellKey(ref))) as never,
    },
    threadEnvironment: {
      ...actual.threadEnvironment,
      visit: { label: "visit", run: mocks.visitRun } as never,
    },
  };
});

import { ThreadVisitWatermark } from "./ThreadVisitWatermark";

// Kept alive so a shell set before its tracker mounts is still there when it does.
const shellAtom = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));

const NOW = Date.parse("2026-01-04T00:00:00.000Z");
const ENVIRONMENT = EnvironmentId.make("environment-visit-watermark");
const threadA: ScopedThreadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("a") };
const threadB: ScopedThreadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("b") };

function setShell(ref: ScopedThreadRef, updatedAt: string) {
  appAtomRegistry.set(shellAtom(shellKey(ref)), {
    environmentId: ref.environmentId,
    id: ref.threadId,
    updatedAt,
    lastVisitedAt: "2026-01-01T00:00:00.000Z",
    latestRun: null,
  });
}

function visitedThreadIds() {
  return mocks.visitRun.mock.calls.map(
    ([, input]) => (input as { input: { threadId: string } }).input.threadId,
  );
}

it("records the visit of the next thread at once after switching threads", async () => {
  mocks.visitRun.mockReset();
  mocks.visitRun.mockReturnValue(Effect.void);
  setShell(threadA, "2026-01-02T00:00:00.000Z");
  setShell(threadB, "2026-01-03T00:00:00.000Z");
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  // A palette pick already sent B's open with its query, so B's visit is a plain watermark advance.
  claimThreadOpen(threadB.environmentId, threadB.threadId, NOW);

  await using screen = await render(
    <AppAtomRegistryProvider>
      <ThreadVisitWatermark threadRef={threadA} />
    </AppAtomRegistryProvider>,
  );
  expect(visitedThreadIds()).toEqual(["a"]);

  await screen.rerender(
    <AppAtomRegistryProvider>
      <ThreadVisitWatermark threadRef={threadB} />
    </AppAtomRegistryProvider>,
  );

  // Thread A's throttle must not hold back B's first watermark: leaving B
  // within the throttle window would otherwise keep it unread.
  expect(visitedThreadIds()).toEqual(["a", "b"]);
});

it("does not mark a run that finishes in a background window as seen", async () => {
  mocks.visitRun.mockReset();
  mocks.visitRun.mockReturnValue(Effect.void);
  const threadC: ScopedThreadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("c") };
  setShell(threadC, "2026-01-02T00:00:00.000Z");
  let focused = true;
  let visibility: DocumentVisibilityState = "visible";
  using _focus = vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  using _visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);

  await using _screen = await render(
    <AppAtomRegistryProvider>
      <ThreadVisitWatermark threadRef={threadC} />
    </AppAtomRegistryProvider>,
  );
  expect(visitedThreadIds()).toEqual(["c"]);

  // The user switches to another app while the run is still working.
  focused = false;
  visibility = "hidden";
  window.dispatchEvent(new Event("blur"));
  document.dispatchEvent(new Event("visibilitychange"));

  const completedAt = "2026-01-03T00:00:00.000Z";
  appAtomRegistry.set(shellAtom(shellKey(threadC)), {
    environmentId: threadC.environmentId,
    id: threadC.threadId,
    updatedAt: completedAt,
    lastVisitedAt: "2026-01-02T00:00:00.000Z",
    latestRun: { completedAt },
  });
  vi.advanceTimersByTime(60_000);

  expect(visitedThreadIds()).toEqual(["c"]);

  focused = true;
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));

  expect(visitedThreadIds()).toEqual(["c", "c"]);
});
