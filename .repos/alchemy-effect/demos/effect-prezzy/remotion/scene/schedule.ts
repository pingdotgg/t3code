import type { AppId, Beat, SceneCapture } from "../../shared/types.ts";
import { highlight } from "./highlight.ts";
import { patchView, staticView, type PatchView } from "./patch.ts";
import { splitEdits } from "./split.ts";

/** Frame budget for each kind of beat, at `fps`. */
export const TIMING = {
  /** Cmd-Tab: switcher overlay, then the target window comes forward. */
  switch: 20,
  switchOverlay: 13,
  /** Frames the picked window takes to come forward after the switcher closes. */
  raise: 3,
  openTab: 14,
  /** A patch: scroll to it and show removed lines in red, swap in the new lines, then hold in green. */
  patch: { show: 12, change: 14, hold: 16 },
  /** Removed lines collapse over this long, then added lines stream in one per `perLine`. */
  patchDelete: 8,
  patchPerLine: 2,
  patchStreamMax: 60,
  /** Base time on the architecture window, plus time per new node or edge. */
  diagram: 90,
  diagramPerAdded: 10,
  diagramMax: 240,
  browserUpdate: 30,
  /** A section heading holds as a caption over the current window this long. */
  slide: 30,
  /** Pointer glides to the element, clicks (or the text lands), the page updates, then a short hold. */
  browserAction: { move: 16, act: 8, hold: 14 },
  /** Click the address bar, paste, press Enter. */
  urlPaste: 14,
  pageLoad: 18,
  browserHold: 12,
} as const;

export interface Segment {
  beat: Beat;
  from: number;
  duration: number;
  /** The window in front during this segment. */
  app: AppId;
  /** The window in front before it; differs from `app` when the segment starts with a switch. */
  previous: AppId;
  /** Frames at the start spent switching windows (0 when already focused). */
  switchFrames: number;
  /** editor.patch / editor.edit / editor.open: the file as diff rows. */
  view?: PatchView;
}

/** One press of → in the presenter: frames `[from, to)` of the scene. */
export interface Step {
  title: string;
  notes: string;
  from: number;
  to: number;
}

export interface SceneSchedule {
  segments: Segment[];
  steps: Step[];
  /** The tabs open when the scene starts, as static views. */
  initialViews: Record<string, PatchView>;
  durationInFrames: number;
}

const appOf = (beat: Beat, current: AppId): AppId => {
  switch (beat.kind) {
    case "focus":
      return beat.app;
    case "editor.open":
    case "editor.edit":
    case "editor.patch":
    case "editor.delete":
      return "editor";
    case "step":
    case "caption":
      return current;
    case "diagram":
      return "diagram";
    // Section headings stay on the current window; the step's title is the caption.
    case "slide":
      return current;
    case "browser.update":
    case "browser.action":
      return "browser";
    case "terminal":
      return "terminal";
    case "browser":
      return "browser";
    case "pause":
      return current;
  }
};

/**
 * How long a patch's change phase lasts: removed lines collapse, then added
 * lines stream in one at a time, so long additions take a little longer.
 */
export const patchChange = (rows: readonly { kind: string }[]) => {
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.some((r) => r.kind === "del");
  const stream = Math.min(TIMING.patchStreamMax, added * TIMING.patchPerLine);
  return Math.max(TIMING.patch.change, (removed ? TIMING.patchDelete : 0) + stream);
};

export const schedule = async (capture: SceneCapture, fps: number): Promise<SceneSchedule> => {
  const segments: Segment[] = [];
  let frame = 0;
  // The scene opens on the first beat's window, without a switch.
  const firstBeat = capture.beats.find(
    (b) => b.kind !== "pause" && b.kind !== "step" && b.kind !== "caption" && b.kind !== "slide",
  );
  let app: AppId = firstBeat ? appOf(firstBeat, "editor") : "editor";
  for (const beat of splitEdits(capture.beats)) {
    const next = appOf(beat, app);
    // Windows cut straight to the next one: no switch animation.
    const switchFrames = 0;
    const segment: Segment = {
      beat,
      from: frame,
      duration: 0,
      app: next,
      previous: app,
      switchFrames,
    };
    let work = 0;
    switch (beat.kind) {
      case "focus":
      case "step":
      case "caption":
        break;
      case "pause":
        work = Math.round(beat.seconds * fps);
        break;
      case "editor.open":
        segment.view = staticView(beat.content, await highlight(beat.file, beat.content));
        work = TIMING.openTab;
        break;
      case "editor.delete":
        work = TIMING.openTab;
        break;
      case "diagram":
        work = Math.min(
          TIMING.diagramMax,
          TIMING.diagram +
            TIMING.diagramPerAdded * (beat.addedNodes.length + beat.addedEdges.length),
        );
        break;
      case "slide":
        work = TIMING.slide;
        break;
      case "browser.action":
        work = TIMING.browserAction.move + TIMING.browserAction.act + TIMING.browserAction.hold;
        break;
      case "browser.update":
        work = TIMING.browserUpdate;
        break;
      case "editor.patch":
      case "editor.edit":
        segment.view = patchView(
          beat.before,
          beat.after,
          await highlight(beat.file, beat.before),
          await highlight(beat.file, beat.after),
        );
        work = TIMING.patch.show + patchChange(segment.view.rows) + TIMING.patch.hold;
        break;
      case "terminal":
        work = Math.max(1, Math.round((beat.end - beat.start) * fps));
        break;
      case "browser":
        work = TIMING.urlPaste + TIMING.pageLoad + TIMING.browserHold;
        break;
    }
    segment.duration = switchFrames + work;
    segments.push(segment);
    frame += segment.duration;
    app = next;
  }
  const initialViews: Record<string, PatchView> = {};
  for (const tab of capture.start.tabs) {
    initialViews[tab.file] = staticView(tab.content, await highlight(tab.file, tab.content));
  }
  const durationInFrames = Math.max(1, frame);

  // Steps: the presenter stops before every step beat, every code edit, and every
  // switch to another window, so nothing advances without a keypress. Empty ones
  // (two stops at the same frame) collapse into the later one.
  const marks: { title: string; notes: string; from: number }[] = [
    { title: capture.title, notes: capture.notes, from: 0 },
  ];
  let title = capture.title;
  let notes = capture.notes;
  for (const segment of segments) {
    const beat = segment.beat;
    if (beat.kind === "step") {
      title = beat.title;
      notes = beat.notes;
    }
    const stop =
      beat.kind === "step" ||
      beat.kind === "editor.patch" ||
      beat.kind === "editor.edit" ||
      beat.kind === "editor.delete" ||
      beat.kind === "terminal" ||
      beat.kind === "browser" ||
      beat.kind === "browser.update" ||
      beat.kind === "browser.action" ||
      (segment.app !== segment.previous && segment.duration > 0);
    if (stop) {
      const mark = { title, notes, from: segment.from };
      if (marks.at(-1)!.from === mark.from) marks[marks.length - 1] = mark;
      else marks.push(mark);
    }
    // Inside a long terminal run, also stop where output resumes after a pause.
    if (beat.kind === "terminal") {
      for (const at of capture.terminal?.pauses ?? []) {
        if (at <= beat.start + 0.5 || at >= beat.end - 0.5) continue;
        const from = segment.from + segment.switchFrames + Math.round((at - beat.start) * fps);
        if (from > marks.at(-1)!.from) marks.push({ title, notes, from });
      }
    }
  }
  const steps: Step[] = marks
    .map((mark, i) => ({
      ...mark,
      to: marks[i + 1]?.from ?? durationInFrames,
    }))
    .filter((step) => step.to > step.from);
  return { segments, steps, initialViews, durationInFrames };
};

/** The segment playing at `frame` (the last one once the scene has ended). */
export const segmentAt = (segments: Segment[], frame: number): Segment | undefined => {
  let found: Segment | undefined;
  for (const segment of segments) {
    if (segment.from <= frame) found = segment;
    else break;
  }
  return found;
};
