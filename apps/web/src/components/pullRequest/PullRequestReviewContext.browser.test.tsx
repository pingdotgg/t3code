import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { usePullRequestPreviousVisit } from "./PullRequestReviewContext";

const prefix = "t3:pr-last-visit:";
const oldVisit = "2026-10-14T10:00:00.000Z";
const now = "2026-10-15T10:00:00.000Z";

function Probe({ id, loaded }: { id: string; loaded: boolean }) {
  const previous = usePullRequestPreviousVisit(id, loaded);
  return <output>{previous ?? "none"}</output>;
}

function setup() {
  localStorage.clear();
  return { [Symbol.dispose]: () => localStorage.clear() };
}

function at(time: string) {
  vi.setSystemTime(new Date(time));
  return time;
}

it("records loaded activity while retaining the previous visit for this view", async () => {
  using _storage = setup();
  using _time = fakeTimers();
  at(now);
  localStorage.setItem(`${prefix}a`, oldVisit);
  await using screen = await render(<Probe id="a" loaded={false} />, {
    // The visit hook does not navigate.
    router: false,
  });
  await expect.element(screen.getByRole("status")).toHaveTextContent(oldVisit);
  expect(localStorage.getItem(`${prefix}a`)).toBe(oldVisit);
  await screen.rerender(<Probe id="a" loaded />);
  await expect.element(screen.getByRole("status")).toHaveTextContent(oldVisit);
  expect(localStorage.getItem(`${prefix}a`)).toBe(now);
  at("2026-10-15T11:00:00.000Z");
  await screen.rerender(<Probe id="a" loaded />);
  await expect.element(screen.getByRole("status")).toHaveTextContent(oldVisit);
  expect(localStorage.getItem(`${prefix}a`)).toBe(now);
});

it("records hiding and leaving the page only after activity loads", async () => {
  using _storage = setup();
  using _time = fakeTimers();
  at(now);
  localStorage.setItem(`${prefix}a`, oldVisit);
  await using screen = await render(<Probe id="a" loaded />, {
    // The visit hook does not navigate.
    router: false,
  });
  const hidden = at("2026-10-15T10:30:00.000Z");
  {
    using _hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(() => document.dispatchEvent(new Event("visibilitychange")));
  }
  expect(localStorage.getItem(`${prefix}a`)).toBe(hidden);
  const closed = at("2026-10-15T10:40:00.000Z");
  await act(() => window.dispatchEvent(new Event("pagehide")));
  expect(localStorage.getItem(`${prefix}a`)).toBe(closed);
  await screen.rerender(<Probe id="a" loaded />);
  await expect.element(screen.getByRole("status")).toHaveTextContent(oldVisit);

  const left = at("2026-10-15T11:00:00.000Z");
  await screen.rerender(<Probe id="offline-pr" loaded={false} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("none");
  expect(localStorage.getItem(`${prefix}a`)).toBe(left);
  at("2026-10-15T11:10:00.000Z");
  await act(() => window.dispatchEvent(new Event("pagehide")));
  expect(localStorage.getItem(`${prefix}offline-pr`)).toBeNull();

  await screen.rerender(<Probe id="a" loaded />);
  await expect.element(screen.getByRole("status")).toHaveTextContent(left);
  const unmounted = at("2026-10-15T11:30:00.000Z");
  await screen.unmount();
  expect(localStorage.getItem(`${prefix}a`)).toBe(unmounted);
});

it("bounds visit history without deleting unrelated preferences", async () => {
  using _storage = setup();
  using _time = fakeTimers();
  at(now);
  localStorage.setItem("theme", "dark");
  for (let index = 0; index < 256; index++)
    localStorage.setItem(`${prefix}${index}`, new Date(index * 1000).toISOString());
  await using _screen = await render(<Probe id="new" loaded />, {
    // The visit hook does not navigate.
    router: false,
  });
  expect(localStorage.getItem(`${prefix}0`)).toBeNull();
  expect(localStorage.getItem(`${prefix}new`)).toBe(now);
  expect(localStorage.getItem("theme")).toBe("dark");
  expect(localStorage.length).toBe(257);
});
