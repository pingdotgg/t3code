import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Preferences } from "../../persistence/mobile-preferences";

const state = vi.hoisted(() => ({
  loaded: false,
  preferences: {} as Preferences,
  save: vi.fn<(input: { transform: (value: Preferences) => Preferences }) => void>(),
  appStateListeners: new Set<(next: string) => void>(),
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: "change", listener: (next: string) => void) => {
      state.appStateListeners.add(listener);
      return { remove: () => state.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: null,
  updateMobilePreferencesAtom: null,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    state.loaded ? AsyncResult.success(state.preferences) : AsyncResult.initial(),
  useAtomSet: () => state.save,
}));

import { pullRequestReviewKey } from "./pullRequestReviewDrafts";
import { usePullRequestPreviousVisit } from "./usePullRequestPreviousVisit";

const params = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  host: "dev.azure.com",
  repository: "sandbox",
  number: 1,
};
const oldVisit = "2026-10-14T10:00:00.000Z";
const now = "2026-10-15T10:00:00.000Z";
let root: Root;
let container: HTMLDivElement;

function Probe({ number, loaded }: { number: number; loaded: boolean }) {
  const previous = usePullRequestPreviousVisit({ ...params, number }, loaded);
  return <output>{previous ?? "none"}</output>;
}

function render(number: number, loaded: boolean) {
  act(() => root.render(<Probe number={number} loaded={loaded} />));
  return container.textContent;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  state.loaded = false;
  state.preferences = { pullRequestVisits: { [pullRequestReviewKey(params)]: oldVisit } };
  state.save.mockReset().mockImplementation(({ transform }) => {
    state.preferences = { ...state.preferences, ...transform(state.preferences) };
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function at(time: string) {
  vi.setSystemTime(new Date(time));
  return time;
}

function stored() {
  return state.preferences.pullRequestVisits?.[pullRequestReviewKey(params)];
}

it("waits for both preferences and activity, then saves without waiting for app shutdown", () => {
  expect(render(1, true)).toBe("none");
  expect(state.save).not.toHaveBeenCalled();
  state.loaded = true;
  expect(render(1, false)).toBe(oldVisit);
  expect(state.save).not.toHaveBeenCalled();
  expect(render(1, true)).toBe(oldVisit);
  expect(stored()).toBe(now);
  render(1, true);
  expect(state.save).toHaveBeenCalledTimes(1);
});

it("records again when the reader backgrounds the app or leaves, but never before activity loads", () => {
  state.loaded = true;
  render(1, true);
  const backgrounded = at("2026-10-15T10:30:00.000Z");
  act(() => state.appStateListeners.forEach((listener) => listener("background")));
  expect(stored()).toBe(backgrounded);
  expect(render(1, true)).toBe(oldVisit);

  const left = at("2026-10-15T11:00:00.000Z");
  expect(render(2, false)).toBe("none");
  expect(stored()).toBe(left);
  const saves = state.save.mock.calls.length;
  at("2026-10-15T11:10:00.000Z");
  act(() => state.appStateListeners.forEach((listener) => listener("inactive")));
  act(() => root.unmount());
  root = createRoot(container);
  expect(state.save).toHaveBeenCalledTimes(saves);

  expect(render(1, true)).toBe(left);
  const unmounted = at("2026-10-15T11:30:00.000Z");
  act(() => root.unmount());
  root = createRoot(container);
  expect(stored()).toBe(unmounted);
});
