// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { usePullRequestPreviousVisit } from "./PullRequestReviewContext";

const prefix = "t3:pr-last-visit:";
const oldVisit = "2026-10-14T10:00:00.000Z";
const now = "2026-10-15T10:00:00.000Z";
let root: Root;
let container: HTMLDivElement;

function Probe({ id, loaded }: { id: string; loaded: boolean }) {
  const previous = usePullRequestPreviousVisit(id, loaded);
  return <output>{previous ?? "none"}</output>;
}

function render(id: string, loaded: boolean) {
  act(() => root.render(<Probe id={id} loaded={loaded} />));
  return container.textContent;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  localStorage.clear();
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

it("records the first loaded activity immediately while retaining the previous visit for this view", () => {
  localStorage.setItem(`${prefix}a`, oldVisit);
  expect(render("a", false)).toBe(oldVisit);
  expect(localStorage.getItem(`${prefix}a`)).toBe(oldVisit);
  expect(render("a", true)).toBe(oldVisit);
  expect(localStorage.getItem(`${prefix}a`)).toBe(now);
  at("2026-10-15T11:00:00.000Z");
  expect(render("a", true)).toBe(oldVisit);
  expect(localStorage.getItem(`${prefix}a`)).toBe(now);
});

it("records again when the reader hides or leaves the page, but never before activity loads", () => {
  localStorage.setItem(`${prefix}a`, oldVisit);
  render("a", true);
  const hidden = at("2026-10-15T10:30:00.000Z");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  Reflect.deleteProperty(document, "visibilityState");
  expect(localStorage.getItem(`${prefix}a`)).toBe(hidden);
  const closed = at("2026-10-15T10:40:00.000Z");
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(localStorage.getItem(`${prefix}a`)).toBe(closed);
  expect(render("a", true)).toBe(oldVisit);

  const left = at("2026-10-15T11:00:00.000Z");
  expect(render("offline-pr", false)).toBe("none");
  expect(localStorage.getItem(`${prefix}a`)).toBe(left);
  at("2026-10-15T11:10:00.000Z");
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(localStorage.getItem(`${prefix}offline-pr`)).toBeNull();

  expect(render("a", true)).toBe(left);
  const unmounted = at("2026-10-15T11:30:00.000Z");
  act(() => root.unmount());
  root = createRoot(container);
  expect(localStorage.getItem(`${prefix}a`)).toBe(unmounted);
});

it("bounds visit history without deleting unrelated preferences", () => {
  localStorage.setItem("theme", "dark");
  for (let index = 0; index < 256; index++)
    localStorage.setItem(`${prefix}${index}`, new Date(index * 1000).toISOString());
  render("new", true);
  expect(localStorage.getItem(`${prefix}0`)).toBeNull();
  expect(localStorage.getItem(`${prefix}new`)).toBe(now);
  expect(localStorage.getItem("theme")).toBe("dark");
  expect(localStorage.length).toBe(257);
});
