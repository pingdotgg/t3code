// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/stop.test.ts), modified for Ada.
import { describe, expect, it, vi } from "vite-plus/test";
import { ComputerUse, ComputerUseRuns } from "./controller.ts";
import type { Grant } from "./controller.ts";
import type { Answers, Question } from "./decisions.ts";
import type { Point, PointerReading, Rect } from "./types.ts";
import { fakeMac } from "./fake.ts";
import { silentLogger } from "./log.ts";
import {
  LocalStop,
  POLL_MS,
  STOPPED_IN_CORNER,
  TAKEN_OVER,
  TAKEOVER_POINTS,
  stopCorners,
} from "./stop.ts";
import type { Schedule } from "./stop.ts";

/** A schedule the test ticks by hand. */
function manual() {
  const ticks: Array<() => void | Promise<void>> = [];
  const intervals: number[] = [];
  let cancelled = 0;
  const schedule: Schedule = (tick, ms) => {
    ticks.push(tick);
    intervals.push(ms);
    return () => {
      cancelled += 1;
    };
  };
  const tick = async () => {
    for (const next of ticks) await next();
  };
  return { schedule, intervals, tick, cancelled: () => cancelled };
}

/** A pointer the test moves, and a watch over it that records why it aborted. */
function watched() {
  let at: Point = { x: 400, y: 300 };
  const timer = manual();
  const aborted: string[] = [];
  const stop = new LocalStop({
    pointer: async () => at,
    schedule: timer.schedule,
    log: silentLogger,
  });
  const watch = stop.watch((reason) => aborted.push(reason));
  return { watch, aborted, timer, move: (point: Point) => (at = point) };
}

describe("LocalStop", () => {
  it("stops the task when the pointer reaches the top-left corner, within 4 points", async () => {
    const { watch, aborted, move, timer } = watched();
    move({ x: 3, y: 2.5 });
    await watch.check();
    expect(aborted).toEqual([STOPPED_IN_CORNER]);
    expect(timer.cancelled()).toBe(1);
  });

  it("with displays around the main one, stops in the corners the pointer is held in, not at an edge it passes through", async () => {
    // A 1920×1080 display to the left of a MacBook's, a little higher: (0, 0) is an edge between them now.
    const layout: Rect[] = [
      { x: 0, y: 0, w: 1512, h: 982 },
      { x: -1920, y: -98, w: 1920, h: 1080 },
    ];
    expect(stopCorners(layout)).toEqual([{ x: -1920, y: -98 }]);
    // One above: the main display's corner is an edge too; side by side at the same top, only the left one's.
    expect(
      stopCorners([
        { x: 0, y: 0, w: 1512, h: 982 },
        { x: -200, y: -1080, w: 1920, h: 1080 },
      ]),
    ).toEqual([{ x: -200, y: -1080 }]);
    expect(
      stopCorners([
        { x: 0, y: 0, w: 1512, h: 982 },
        { x: 1512, y: 0, w: 1920, h: 1080 },
      ]),
    ).toEqual([{ x: 0, y: 0 }]);
    // Diagonal only: the pointer can still slide on into the other display.
    expect(
      stopCorners([
        { x: 0, y: 0, w: 1512, h: 982 },
        { x: -1920, y: -1080, w: 1920, h: 1080 },
      ]),
    ).toEqual([{ x: -1920, y: -1080 }]);
    expect(stopCorners([])).toEqual([{ x: 0, y: 0 }]);

    let at: Point = { x: 1, y: 1 };
    const aborted: string[] = [];
    const stop = new LocalStop({
      pointer: async () => at,
      displays: async () => layout,
      schedule: manual().schedule,
      log: silentLogger,
    });
    const watch = stop.watch((reason) => aborted.push(reason));
    await Promise.resolve();
    watch.left({ x: 1, y: 1 });
    await watch.check();
    expect(aborted).toEqual([]);
    at = { x: -1918, y: -96 };
    watch.left(at);
    await watch.check();
    expect(aborted).toEqual([STOPPED_IN_CORNER]);
  });

  it("does not stop just outside the corner", async () => {
    const { watch, aborted, move } = watched();
    watch.left({ x: 5, y: 5 });
    move({ x: 4, y: 3 });
    await watch.check();
    expect(aborted).toEqual([]);
  });

  it("stops when the person moves the pointer more than 24 points from where the helper left it", async () => {
    const { watch, aborted, move } = watched();
    watch.left({ x: 100, y: 100 });
    move({ x: 110, y: 110 });
    await watch.check();
    expect(aborted).toEqual([]);
    move({ x: 130, y: 100 });
    await watch.check();
    expect(aborted).toEqual([TAKEN_OVER]);
  });

  it("ignores the helper’s own movement and the wait for the box, but the corner still stops it", async () => {
    const { watch, aborted, move } = watched();
    watch.left({ x: 100, y: 100 });
    watch.moving();
    move({ x: 900, y: 700 });
    await watch.check();
    expect(aborted).toEqual([]);
    watch.left({ x: 900, y: 700 });
    move({ x: 905, y: 700 });
    await watch.check();
    expect(aborted).toEqual([]);
    watch.moving();
    move({ x: 0, y: 0 });
    await watch.check();
    expect(aborted).toEqual([STOPPED_IN_CORNER]);
  });

  it("Windows run 2026-10-27: after a background step (or the wait for the box) the person’s mouse is theirs; only the corner stops it", async () => {
    const { watch, aborted, move } = watched();
    // The box answers (moving … released), then the background click (moving … released): no pointer was used.
    watch.moving();
    watch.released?.();
    watch.moving();
    watch.released?.();
    move({ x: 100, y: 100 });
    await watch.check();
    move({ x: 900, y: 700 });
    await watch.check();
    move({ x: 300, y: 500 });
    await watch.check();
    expect(aborted).toEqual([]);
    move({ x: 0, y: 0 });
    await watch.check();
    expect(aborted).toEqual([STOPPED_IN_CORNER]);
  });

  it("takes the next reading as the expected place after a movement to somewhere unknown", async () => {
    const { watch, aborted, move } = watched();
    watch.left(null);
    move({ x: 640, y: 20 });
    await watch.check();
    expect(aborted).toEqual([]);
    move({ x: 300, y: 500 });
    await watch.check();
    expect(aborted).toEqual([TAKEN_OVER]);
  });

  it("keeps the expected place when an action did not move the pointer", async () => {
    const { watch, aborted, move } = watched();
    watch.left({ x: 100, y: 100 });
    watch.moving();
    watch.left();
    move({ x: 200, y: 100 });
    await watch.check();
    expect(aborted).toEqual([TAKEN_OVER]);
  });

  it("polls every 250 ms, aborts once, and stops polling when the task ends", async () => {
    const { watch, aborted, move, timer } = watched();
    expect(timer.intervals).toEqual([POLL_MS]);
    expect(POLL_MS).toBe(250);
    move({ x: 1, y: 1 });
    timer.tick();
    await vi.waitFor(() => expect(aborted).toEqual([STOPPED_IN_CORNER]));
    timer.tick();
    await watch.check();
    expect(aborted).toEqual([STOPPED_IN_CORNER]);
    watch.end();
    expect(timer.cancelled()).toBe(1);
  });

  it("does nothing after the task ended", async () => {
    const { watch, aborted, move } = watched();
    watch.end();
    move({ x: 0, y: 0 });
    await watch.check();
    expect(aborted).toEqual([]);
  });

  it("does NOT stop a background task when the person uses their own pointer while it works (JJ: virtual mouse)", async () => {
    const mac = fakeMac();
    const timer = manual();
    const stop = new LocalStop({
      pointer: () => mac.desktop.pointer(),
      schedule: timer.schedule,
      log: silentLogger,
    });
    const decider = {
      ask: async (_state: unknown, questions: Record<string, Question>): Promise<Answers> => {
        if ("surface" in questions)
          return { surface: { type: "choice", choice: "current", probability: 0.9 } };
        // The person moves their own mouse across the screen mid-task; the fake acts in the background, so it is theirs.
        mac.desktop.movePointer({ x: 900, y: 700 });
        await timer.tick();
        return {
          next: { type: "choice", choice: "type_text", probability: 0.9 },
          type_into: { type: "choice", choice: "c0", probability: 0.9 },
        };
      },
    };
    const runs = new ComputerUseRuns({
      create: (session) =>
        new ComputerUse({
          ...session,
          tabs: null,
          desktop: mac.desktop,
          dock: mac.dock,
          apps: mac.apps,
          log: silentLogger,
          settleMs: 0,
        }),
      watch: (abort) => stop.watch(abort),
      log: silentLogger,
    });
    const started = runs.start(
      "task_1",
      { goal: "search my notes for groceries", text: "groceries" },
      { decider, authorize: async (): Promise<Grant> => ({ ok: true, grant: "allow" }) },
    );
    if (!started.ok) throw new Error("refused");
    const outcome = await started.finished;
    // The task ran its background steps despite the pointer moving; it was not stopped as a takeover.
    expect(outcome.status).not.toBe("stopped");
    expect(mac.desktop.actions.some((a) => a.kind === "type")).toBe(true);
    expect(mac.desktop.modes.every((m) => m === "background")).toBe(true);
  });

  it("the corner still stops a background task at once, with no real pointer involved", async () => {
    const mac = fakeMac();
    const timer = manual();
    const stop = new LocalStop({
      pointer: () => mac.desktop.pointer(),
      schedule: timer.schedule,
      log: silentLogger,
    });
    const decider = {
      ask: async (_state: unknown, questions: Record<string, Question>): Promise<Answers> => {
        if ("surface" in questions)
          return { surface: { type: "choice", choice: "current", probability: 0.9 } };
        // The person drops the pointer into the top-left corner: the emergency stop, which always works.
        mac.desktop.movePointer({ x: 1, y: 1 });
        await timer.tick();
        return {
          next: { type: "choice", choice: "type_text", probability: 0.9 },
          type_into: { type: "choice", choice: "c0", probability: 0.9 },
        };
      },
    };
    const runs = new ComputerUseRuns({
      create: (session) =>
        new ComputerUse({
          ...session,
          tabs: null,
          desktop: mac.desktop,
          dock: mac.dock,
          apps: mac.apps,
          log: silentLogger,
          settleMs: 0,
        }),
      watch: (abort) => stop.watch(abort),
      log: silentLogger,
    });
    const started = runs.start(
      "task_1",
      { goal: "search my notes for groceries", text: "groceries" },
      { decider, authorize: async (): Promise<Grant> => ({ ok: true, grant: "allow" }) },
    );
    if (!started.ok) throw new Error("refused");
    expect(await started.finished).toMatchObject({ status: "stopped", reason: STOPPED_IN_CORNER });
    expect(timer.cancelled()).toBe(1);
  });
});

/** A pointer read on each poll, a clock, and a watch; `polls` runs the 250 ms polls the way the schedule does. */
function polled(start: PointerReading = { x: 500, y: 400 }) {
  let at: PointerReading = start;
  let t = 1_000_000;
  const timer = manual();
  const aborted: string[] = [];
  const stop = new LocalStop({
    pointer: async () => at,
    schedule: timer.schedule,
    now: () => t,
    log: silentLogger,
  });
  const watch = stop.watch((reason) => aborted.push(reason));
  const poll = async (point: PointerReading) => {
    at = point;
    t += POLL_MS;
    await timer.tick();
  };
  return { watch, aborted, poll, now: () => t };
}

describe("LocalStop: only a deliberate move or a click is a takeover", () => {
  it("a hand resting on the trackpad (±3 points of jitter) never stops it", async () => {
    const { watch, aborted, poll } = polled();
    watch.left({ x: 500, y: 400 });
    for (let i = 0; i < 80; i++) await poll({ x: 500 + (i % 2 ? 3 : -3), y: 400 + (i % 3) - 1 });
    expect(aborted).toEqual([]);
  });

  it("slow drift (2 points a reading, 20 s) does not add up to a takeover", async () => {
    const { watch, aborted, poll } = polled();
    watch.left({ x: 500, y: 400 });
    for (let i = 1; i <= 80; i++) await poll({ x: 500 + 2 * i, y: 400 });
    expect(aborted).toEqual([]);
  });

  it("one stray reading is not a move; the same distance held for two readings is", async () => {
    const { watch, aborted, poll } = polled();
    watch.left({ x: 500, y: 400 });
    await poll({ x: 500 + TAKEOVER_POINTS + 10, y: 400 });
    await poll({ x: 500, y: 400 });
    expect(aborted).toEqual([]);
    await poll({ x: 560, y: 430 });
    expect(aborted).toEqual([]);
    await poll({ x: 600, y: 450 });
    expect(aborted).toEqual([TAKEN_OVER]);
  });

  it("a move of under 24 points is not one", async () => {
    const { watch, aborted, poll } = polled();
    watch.left({ x: 500, y: 400 });
    await poll({ x: 515, y: 410 });
    await poll({ x: 518, y: 412 });
    await poll({ x: 518, y: 412 });
    expect(aborted).toEqual([]);
  });

  it("the helper’s own moves and clicks never count: it reports where it left the pointer", async () => {
    const { watch, aborted, poll } = polled();
    watch.left({ x: 500, y: 400 });
    // A click across the screen, as the Mac backend does it (move, down, up), then the pointer read there.
    watch.moving();
    await poll({ x: 1200, y: 90, sinceClickS: 0 });
    watch.left({ x: 1200, y: 90 });
    await poll({ x: 1200, y: 90, sinceClickS: 0.3 });
    await poll({ x: 1201, y: 91, sinceClickS: 0.55 });
    // Scrolling moves it to the window's middle; a Dock click leaves it somewhere unknown.
    watch.moving();
    watch.left({ x: 700, y: 500 });
    await poll({ x: 700, y: 500, sinceClickS: 2 });
    watch.moving();
    watch.left(null);
    await poll({ x: 640, y: 1050, sinceClickS: 0.1 });
    await poll({ x: 641, y: 1050, sinceClickS: 0.35 });
    expect(aborted).toEqual([]);
  });

  it("a click after the helper last acted is the person taking over, wherever the pointer is", async () => {
    const { watch, aborted, poll } = polled();
    watch.left({ x: 500, y: 400 });
    await poll({ x: 500, y: 400, sinceClickS: 5 });
    await poll({ x: 500, y: 400, sinceClickS: 5.25 });
    await poll({ x: 502, y: 401, sinceClickS: 0.1 });
    expect(aborted).toEqual([TAKEN_OVER]);
  });

  it("the corner still stops at once, even while the helper moves the pointer", async () => {
    const { watch, aborted, poll } = polled();
    watch.moving();
    await poll({ x: 1, y: 2 });
    expect(aborted).toEqual([STOPPED_IN_CORNER]);
  });
});
