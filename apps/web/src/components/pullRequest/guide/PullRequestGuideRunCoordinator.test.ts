import type { AnyRouter } from "@tanstack/react-router";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "~/hooks/useSettings";
import { guideRunKey, useGuideRunStore } from "./guideRunStore";
import { startGuideRunNotifications } from "./PullRequestGuideRunCoordinator";

const guides = vi.hoisted(() => ({
  family: null as unknown as (key: string) => unknown,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      reviewGuide: ((target: { environmentId: string; input: PullRequestRef }) =>
        guides.family(`${target.environmentId}:${target.input.number}`)) as never,
    },
  };
});

const guideAtom = Atom.family((_key: string) =>
  Atom.make<AsyncResult.AsyncResult<PullRequestReviewGuideResult, never>>(AsyncResult.initial()),
);
guides.family = guideAtom;

const environmentId = EnvironmentId.make("env-1");
function reference(number: number): PullRequestRef {
  return { projectId: ProjectId.make("project-1"), repository: "acme/app", number };
}
const running = {
  guide: null,
  run: { _tag: "Running" },
} as unknown as PullRequestReviewGuideResult;
const idle = { guide: null, run: null } as unknown as PullRequestReviewGuideResult;

function setup() {
  useGuideRunStore.setState({ watches: {} });
  const registry = AtomRegistry.make();
  const refresh = vi.spyOn(registry, "refresh");
  const refreshed = () =>
    refresh.mock.calls.flatMap(([atom]) =>
      [1, 2].filter((number) => atom === guideAtom(`${environmentId}:${number}`)).map(String),
    );
  const stop = startGuideRunNotifications(registry, { navigate: vi.fn() } as unknown as AnyRouter);
  const watch = (number: number, since = 0) =>
    useGuideRunStore.getState().watch({
      environmentId,
      reference: reference(number),
      title: null,
      previousGuideAt: null,
      previousFailedAt: null,
      since,
    });
  return { registry, refreshed, stop, watch };
}

it("polls each watched run once, however often the watches change", () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const { registry, refreshed, stop, watch } = setup();
  registry.set(guideAtom(`${environmentId}:1`), AsyncResult.success(running));
  registry.set(guideAtom(`${environmentId}:2`), AsyncResult.success(running));
  watch(1);
  watch(2);
  vi.advanceTimersByTime(5_000);
  expect(refreshed().toSorted()).toEqual(["1", "2"]);
  stop();
});

it("does not keep polling a run that settles on its first read", () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const { registry, refreshed, stop, watch } = setup();
  // Long unseen and not running: the first read retires the watch.
  registry.set(guideAtom(`${environmentId}:1`), AsyncResult.success(idle));
  watch(1, 0);
  expect(useGuideRunStore.getState().watches[guideRunKey(environmentId, reference(1))]).toBe(
    undefined,
  );
  vi.advanceTimersByTime(5_000);
  expect(refreshed()).toEqual([]);
  stop();
});

it("does not report the previous run's failure when a Running answer starts a watch", () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const { registry, stop } = setup();
  const atom = guideAtom(`${environmentId}:1`);
  const key = guideRunKey(environmentId, reference(1));
  registry.set(
    atom,
    AsyncResult.success({
      guide: null,
      run: { _tag: "Failed", failedAt: "2026-10-01T00:00:00.000Z", detail: "old failure" },
    } as unknown as PullRequestReviewGuideResult),
  );
  // What the reviewGuide answer handler does before the Running answer replaces the atom's value.
  useGuideRunStore.getState().watch({
    environmentId,
    reference: reference(1),
    title: null,
    previousGuideAt: null,
    previousFailedAt: null,
    since: 0,
    answeredRunning: true,
  });
  expect(useGuideRunStore.getState().watches[key]).toBeDefined();
  registry.set(atom, AsyncResult.success(running));
  expect(useGuideRunStore.getState().watches[key]).toBeDefined();
  registry.set(atom, AsyncResult.success(idle));
  expect(useGuideRunStore.getState().watches[key]).toBe(undefined);
  stop();
});

it("gives each finished guide's notification its own tag within the Windows toast limit", () => {
  using _cleanup = {
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      __resetClientSettingsPersistenceForTests();
    },
  };
  const tags: string[] = [];
  vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => false });
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor(_title: string, options: NotificationOptions) {
        tags.push(options.tag!);
      }
      addEventListener() {}
    },
  );
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, notificationMode: "notifications" });
  const registry = AtomRegistry.make();
  const stop = startGuideRunNotifications(registry, { navigate: vi.fn() } as unknown as AnyRouter);
  const uuidEnvironmentId = EnvironmentId.make("fd6fff30-f90b-4ee7-9812-4cf497791b90");
  const written = {
    guide: { generatedAt: "2026-10-01T00:00:00.000Z" },
    run: null,
  } as unknown as PullRequestReviewGuideResult;
  for (const number of [1234, 1235]) {
    registry.set(guideAtom(`${uuidEnvironmentId}:${number}`), AsyncResult.success(written));
    useGuideRunStore.getState().watch({
      environmentId: uuidEnvironmentId,
      reference: {
        projectId: ProjectId.make("a8395a98-a186-4fe7-9d4c-fb8ba63b7588"),
        repository: "pingdotgg/t3code",
        number,
      },
      title: null,
      previousGuideAt: null,
      previousFailedAt: null,
      since: 0,
    });
  }
  expect(tags).toHaveLength(2);
  for (const tag of tags) expect(tag.length).toBeLessThanOrEqual(64);
  expect(new Set(tags).size).toBe(2);
  stop();
});
