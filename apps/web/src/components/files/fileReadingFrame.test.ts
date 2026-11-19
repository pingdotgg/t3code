import { describe, expect, it } from "vite-plus/test";

import { FrameReading } from "./fileReadingFrame";

const at = (y: number) => ({ x: 0, y });
const restore = (y: number) => ({ type: "restore", scroll: at(y) }) as const;
const save = (y: number) => ({ type: "save", scroll: at(y) }) as const;
const RETRY = { type: "retry" } as const;
const REVEAL = { type: "reveal" } as const;
const SHOW = { type: "show" } as const;

/** Retries until the hold gives up, and every action they returned. */
function retryAll(reading: FrameReading<object>, frame: object) {
  const actions = [];
  for (let step = 0; step < 20; step += 1) {
    const next = reading.retry(frame);
    if (next.length === 0) break;
    actions.push(...next);
  }
  return actions;
}

describe("FrameReading", () => {
  it("keeps the restore target, not a short report from the hold, as the place", () => {
    const reading = new FrameReading<object>(at(5000));
    const [shown, next] = [{}, {}];
    // A page that scrolls itself before its load is restored all the same.
    expect(reading.report(shown, "shown", at(9000))).toEqual([]);
    expect(reading.load(shown, "shown")).toEqual([restore(5000)]);
    expect(reading.restored(shown, "shown")).toEqual([RETRY]);
    expect(reading.report(shown, "shown", at(2000))).toEqual([restore(5000)]);

    expect(reading.load(next, "next")).toEqual([restore(5000)]);
    expect(reading.restored(next, "next")).toEqual([RETRY, REVEAL]);
    expect(reading.swap(next)).toEqual([SHOW]);
  });

  it("sends the next revision the place the reader moved to while it restored, before showing it", () => {
    const reading = new FrameReading<object>(null);
    const [shown, next] = [{}, {}];
    reading.load(shown, "shown");
    expect(reading.report(shown, "shown", at(1200))).toEqual([save(1200)]);
    expect(reading.load(next, "next")).toEqual([restore(1200)]);
    expect(reading.restored(next, "next")).toEqual([RETRY, REVEAL]);
    expect(reading.report(shown, "shown", at(1600))).toEqual([save(1600)]);

    expect(reading.swap(next)).toEqual([restore(1600)]);
    // The retry its first restore started is still due, so one chain holds it from here.
    expect(reading.restored(next, "next")).toEqual([REVEAL]);
    // Once that chain ends, a restore after the reader moves again starts another.
    retryAll(reading, next);
    expect(reading.report(shown, "shown", at(2000))).toEqual([save(2000)]);
    expect(reading.swap(next)).toEqual([restore(2000)]);
    expect(reading.restored(next, "next")).toEqual([RETRY, REVEAL]);
    expect(reading.swap(next)).toEqual([SHOW]);

    // On a first visit, the revision loads before any place; the reader scrolls before it shows.
    const first = new FrameReading<object>(null);
    const [page, edited] = [{}, {}];
    first.load(page, "shown");
    expect(first.load(edited, "next")).toEqual([REVEAL]);
    expect(first.report(page, "shown", at(900))).toEqual([save(900)]);
    expect(first.swap(edited)).toEqual([restore(900)]);
    expect(first.restored(edited, "next")).toEqual([RETRY, REVEAL]);
    expect(first.swap(edited)).toEqual([SHOW]);
  });

  it("asks a page that grows without scrolling again, then lets it be after the hold", () => {
    const reading = new FrameReading<object>(at(3000));
    const page = {};
    reading.load(page, "shown");
    reading.restored(page, "shown");
    expect(reading.retry(page)).toEqual([restore(3000), RETRY]);
    expect(reading.report(page, "shown", at(700))).toEqual([restore(3000)]);
    const held = retryAll(reading, page);
    expect(held.filter((action) => action.type === "restore").length).toBeGreaterThan(5);
    expect(reading.retry(page)).toEqual([]);
    expect(reading.report(page, "shown", at(650))).toEqual([save(650)]);

    const grown = new FrameReading<object>(at(3000));
    grown.load(page, "shown");
    grown.restored(page, "shown");
    expect(grown.report(page, "shown", at(3000))).toEqual([]);
    expect(grown.retry(page)).toEqual([]);
    expect(grown.report(page, "shown", at(3400))).toEqual([save(3400)]);

    // A wider panel leaves no room to the side; the page reached its place all the same.
    const wider = new FrameReading<object>({ x: 300, y: 3000 });
    const narrow = {};
    wider.load(narrow, "shown");
    wider.restored(narrow, "shown");
    expect(wider.report(narrow, "shown", at(3000))).toEqual([]);
    expect(wider.retry(narrow)).toEqual([]);
  });

  it("keeps the save of one page from a later page that was shown before it loaded", () => {
    const reading = new FrameReading<object>(null);
    const [first, late, plain] = [{}, {}, {}];
    reading.load(first, "shown");
    expect(reading.report(first, "shown", at(1200))).toEqual([save(1200)]);

    reading.swapTimedOut(late);
    expect(reading.report(late, "shown", at(40))).toEqual([]);
    expect(reading.load(late, "shown")).toEqual([save(40)]);
    expect(reading.report(late, "shown", at(90))).toEqual([save(90)]);

    // A page that did not move before its late load is restored to the place.
    reading.swapTimedOut(plain);
    expect(reading.load(plain, "shown")).toEqual([restore(90)]);
  });

  it("saves nothing from a document the frame navigated to", () => {
    const reading = new FrameReading<object>(null);
    const frame = {};
    reading.load(frame, "shown");
    expect(reading.report(frame, "shown", at(300))).toEqual([save(300)]);
    expect(reading.load(frame, "shown")).toEqual([]);
    expect(reading.report(frame, "shown", at(4321))).toEqual([]);
  });

  it("waits once for a revision without the scroll script, then shows later ones on load", () => {
    const reading = new FrameReading<object>(at(1500));
    const [first, second, third] = [{}, {}, {}];
    reading.load(first, "shown");
    expect(reading.load(second, "next")).toEqual([restore(1500)]);
    reading.swapTimedOut(second);
    // The reader follows a link to a page with the scroll script, which says nothing for the file.
    reading.load(second, "shown");
    expect(reading.report(second, "shown", at(300))).toEqual([]);
    expect(reading.restored(second, "shown")).toEqual([]);
    expect(reading.load(third, "next")).toEqual([restore(1500), REVEAL]);
    reading.restored(third, "next");
    expect(reading.load({}, "next")).toEqual([restore(1500)]);
  });
});
