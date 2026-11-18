// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/stop.ts), modified for Ada.
import type { TaskWatch } from "./controller.ts";
import type { Point, PointerReading, Rect } from "./types.ts";
import { silentLogger } from "./log.ts";
import type { Logger } from "./log.ts";

/**
 * The local stop: the person at the computer can always end a task without the server. Moving the pointer into a
 * top-left corner it stops in ends the task, always. In the background their own pointer and keyboard are theirs;
 * only during a step they allowed does a deliberate move away from where the helper left it take over.
 */
export const CORNER_POINTS = 4;
export const TAKEOVER_POINTS = 24;
/** Steps between two readings up to this are jitter or drift: the baseline follows them. */
export const JITTER_POINTS = 6;
/** Readings in a row beyond TAKEOVER_POINTS before a poll stops the task (the check before an action needs one). */
export const SUSTAINED_READINGS = 2;
/** A click this long after the helper last acted is the person's (the probe and the poll run late by up to this). */
export const CLICK_MARGIN_MS = 400;
export const POLL_MS = 250;
/** After the helper lets go of the real pointer, how long the person's moves still count as taking it back. */
export const HOLD_AFTER_MS = 1500;

export const STOPPED_IN_CORNER = "You stopped it on this computer.";
export const TAKEN_OVER =
  "You moved the pointer while it was using your mouse, so it stopped and left the rest to you.";

/** Runs `tick` every `ms` until the returned function is called. A tick returns the poll it started, so a test can await it. */
export type Schedule = (tick: () => void | Promise<void>, ms: number) => () => void;

const every: Schedule = (tick, ms) => {
  const timer = setInterval(() => void tick(), ms);
  timer.unref();
  return () => clearInterval(timer);
};

export type LocalStopOptions = {
  /** Where the pointer is now, in global top-left-origin points. */
  pointer: () => Promise<PointerReading>;
  /** Every display's bounds, read once a task; without it the corner is (0, 0). */
  displays?: () => Promise<Rect[]>;
  schedule?: Schedule;
  now?: () => number;
  intervalMs?: number;
  log?: Logger;
};

export class LocalStop {
  private readonly options: LocalStopOptions;

  constructor(options: LocalStopOptions) {
    this.options = options;
  }

  /** Starts watching for one task; `abort` is called once, with the reason, when the person stops it. */
  watch(abort: (reason: string) => void): TaskWatch {
    return new PointerTaskWatch(this.options, abort);
  }
}

const inside = (d: Rect, x: number, y: number) =>
  x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h;

/**
 * The top-left corners the pointer stops in: a display's top-left point, unless another display lies just left of
 * it, above it or diagonally (the pointer would move on into that display, so it is an edge). No displays: (0, 0).
 */
export function stopCorners(displays: Rect[]): Point[] {
  const real = displays.filter((d) => d.w > 0 && d.h > 0);
  if (!real.length) return [{ x: 0, y: 0 }];
  return real
    .filter(
      (d) =>
        !real.some(
          (o) =>
            o !== d &&
            (inside(o, d.x - 1, d.y) || inside(o, d.x, d.y - 1) || inside(o, d.x - 1, d.y - 1)),
        ),
    )
    .map((d) => ({ x: d.x, y: d.y }));
}

class PointerTaskWatch implements TaskWatch {
  private readonly pointer: () => Promise<PointerReading>;
  private readonly now: () => number;
  private readonly abort: (reason: string) => void;
  private readonly log: Logger;
  private readonly cancel: () => void;
  /** Where the helper left the pointer (moved along by jitter and drift); null until the next reading sets it. */
  private expected: Point | null = null;
  /** The previous reading, for the step since it. */
  private last: Point | null = null;
  /** Readings in a row beyond TAKEOVER_POINTS. */
  private beyond = 0;
  /** When the helper last finished touching the pointer: a click after this is the person's. */
  private leftAt: number;
  private helperMoving = false;
  /** The helper holds the real pointer for an allowed step: from `moving()` until a while after `left()`. */
  private holding = false;
  private holdUntil = 0;
  /** Changes whenever the helper moves the pointer, so a reading taken before that is not judged after it. */
  private generation = 0;
  private polling = false;
  private ended = false;
  private warned = false;
  private corners: Point[] = [{ x: 0, y: 0 }];

  constructor(options: LocalStopOptions, abort: (reason: string) => void) {
    this.pointer = options.pointer;
    options.displays?.().then(
      (displays) => {
        this.corners = stopCorners(displays);
      },
      (error: unknown) =>
        this.log.warn("local_stop.displays_unreadable", {
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    this.now = options.now ?? Date.now;
    this.leftAt = this.now();
    this.abort = abort;
    this.log = options.log ?? silentLogger;
    this.cancel = (options.schedule ?? every)(
      () => void this.poll(),
      options.intervalMs ?? POLL_MS,
    );
  }

  async check(): Promise<void> {
    if (this.ended) return;
    const generation = this.generation;
    const point = await this.read();
    if (point) this.judge(point, generation, 1);
  }

  /** The helper is about to use the real pointer for a step the person allowed. */
  moving(): void {
    this.holding = true;
    this.helperMoving = true;
    this.generation += 1;
    this.beyond = 0;
  }

  /**
   * The helper let go of the real pointer, at `point` (undefined: it did not move it; null: somewhere unknown). The
   * person's moves just after count as a takeover for a moment (HOLD_AFTER_MS): their hand was waiting for it to finish.
   */
  left(point?: Point | null): void {
    this.holding = true;
    this.helperMoving = false;
    this.generation += 1;
    this.beyond = 0;
    this.leftAt = this.now();
    this.holdUntil = this.now() + HOLD_AFTER_MS;
    if (point === null) this.expected = this.last = null;
    else if (point) this.expected = this.last = { x: point.x, y: point.y };
  }

  released(): void {
    this.holding = false;
    this.helperMoving = false;
    this.generation += 1;
    this.beyond = 0;
    this.expected = this.last = null;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.cancel();
  }

  private async poll() {
    if (this.polling || this.ended) return;
    this.polling = true;
    try {
      if (this.ended) return;
      const generation = this.generation;
      const point = await this.read();
      if (point) this.judge(point, generation, SUSTAINED_READINGS);
    } finally {
      this.polling = false;
    }
  }

  private async read(): Promise<PointerReading | null> {
    try {
      return await this.pointer();
    } catch (error) {
      if (!this.warned)
        this.log.warn("local_stop.pointer_unreadable", {
          error: error instanceof Error ? error.message : String(error),
        });
      this.warned = true;
      return null;
    }
  }

  /** `needed`: readings in a row beyond the takeover distance before it stops (polls 2, the check before an action 1). */
  private judge(point: PointerReading, generation: number, needed: number) {
    if (this.ended) return;
    if (this.corners.some((c) => Math.hypot(point.x - c.x, point.y - c.y) <= CORNER_POINTS))
      return this.stop(STOPPED_IN_CORNER);
    // In the background the pointer is the person's: only the corner stops the task.
    if (this.holding && !this.helperMoving && this.now() > this.holdUntil) {
      this.holding = false;
      this.expected = this.last = null;
    }
    if (!this.holding) return;
    if (this.helperMoving || generation !== this.generation) return;
    // A click since the helper last acted (its own clicks were before that) is the person taking over.
    if (
      point.sinceClickS !== undefined &&
      this.now() - point.sinceClickS * 1000 > this.leftAt + CLICK_MARGIN_MS
    )
      return this.stop(TAKEN_OVER);
    const here = { x: point.x, y: point.y };
    if (!this.expected || !this.last) {
      this.expected = this.last = here;
      this.beyond = 0;
      return;
    }
    // Jitter and drift: the baseline follows small steps, so they never add up to a move.
    if (Math.hypot(here.x - this.last.x, here.y - this.last.y) <= JITTER_POINTS) {
      this.expected = {
        x: this.expected.x + here.x - this.last.x,
        y: this.expected.y + here.y - this.last.y,
      };
    }
    this.last = here;
    if (Math.hypot(here.x - this.expected.x, here.y - this.expected.y) > TAKEOVER_POINTS) {
      this.beyond += 1;
      if (this.beyond >= needed) this.stop(TAKEN_OVER);
    } else this.beyond = 0;
  }

  private stop(reason: string) {
    this.end();
    this.log.info("local_stop.stopped", { reason });
    this.abort(reason);
  }
}
