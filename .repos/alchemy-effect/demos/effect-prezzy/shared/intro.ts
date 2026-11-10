/**
 * The intro, resolved: `intro/build.ts` turns the authored steps
 * (`intro/steps.ts`) into this JSON (tokens highlighted, marks and type
 * errors located), and the Remotion `Intro` composition renders it. Every
 * step is one press of → in the presenter.
 */

export interface Token {
  text: string;
  color: string;
  bold?: boolean;
}

export type Tone = "construct" | "runtime" | "good" | "bad" | "neutral";

/** A hand-drawn mark over a range of code (0-based line/column). */
export interface Mark {
  kind: "circle" | "underline" | "strike" | "box" | "highlight";
  line: number;
  col: number;
  len: number;
  /** For multi-line boxes: the last line covered. */
  toLine?: number;
  label?: string;
  side?: "right" | "left" | "above" | "below";
  tone?: Tone;
  /** Set the label further away, with a hand-drawn arrow pointing at the mark. */
  arrow?: boolean;
}

/** A span of text in a code block. */
export interface Span {
  line: number;
  col: number;
  len: number;
}

/** A line drawn from text in one pane to text in the pane beside it. */
export interface CodeLink {
  from: Span;
  to: Span;
  tone?: Tone;
}

export interface CodeError {
  line: number;
  col: number;
  len: number;
  code: string;
  message: string[];
  /** Shown under the code, like an editor tooltip, instead of in the right column. */
  below?: boolean;
}

export interface PanelItem {
  title: string;
  body?: string;
  mono?: string;
  tone?: Tone;
  /** 0–1: draws a proportional bar (illustrative sizes). */
  bar?: number;
}

/** The Worker's bundle beside the code: its size and every client in it. */
export interface BundlePanel {
  label: string;
  /** Kilobytes. */
  size: number;
  /** Every client in the bundle. */
  items: string[];
  /** The clients the code actually calls. */
  used?: string[];
  /** Hand-written note under the wall; `{extra}` is the number of unused clients. */
  note?: string;
}

/** One entry of an Effect's `Req`: open until something provides it. */
export interface ReqItem {
  /** The requirement's type name, as the compiler prints it. */
  name: string;
  state?: "open" | "met" | "bad";
  /** Short text beside it: what it's for, or what satisfies it. `\n` breaks lines. */
  note?: string;
}

/** The requirements of the code on screen, listed beside it. */
export interface ReqPanel {
  label: string;
  items: ReqItem[];
  /** Other Effects' Req, each under its own small heading below `items`. */
  parts?: { label: string; items: ReqItem[] }[];
}

/** Construction creates the resources once; then requests arrive, over and over. */
export interface PhaseTimeline {
  /** Rows, top to bottom; the last is the function that runs per request. */
  resources: { title: string; color: string }[];
  requests: number;
}

/** A value threaded down a call chain, drawn beside the code. */
export interface Drill {
  /** Small heading above the chain. */
  label: string;
  /** The value being passed down: highlighted and threaded wherever it appears. */
  name: string;
  /** One call per line, outermost first; leading spaces set the depth. */
  lines: string[];
  /** Hand-written note under the chain. */
  note?: string;
}

/** A small architecture drawing beside the code: it evolves with the code. */
export interface MiniNode {
  id: string;
  title: string;
  color: string;
  /** Centre, in pixels inside the drawing area. */
  x: number;
  y: number;
  /** Config lines under the node; lines new in this step appear in green. */
  notes?: string[];
  /** A hypothetical node: dashed outline, e.g. "what would this even be?" */
  ghost?: boolean;
}

export interface MiniGraph {
  nodes: MiniNode[];
  /** `label` sits on the arrow: the permission that connection grants. */
  edges: { from: string; to: string; tone?: Tone; label?: string }[];
  /** Short facts shown under the drawing (permissions, env vars, errors). */
  cards?: { text: string; tone?: Tone }[];
  /** Requests arriving at a node from outside, drawn as a looping stream. */
  incoming?: { to: string; label: string; tone?: Tone };
  /** A dashed frame around the whole drawing, e.g. "everything construction builds". */
  frame?: { label: string; tone?: Tone };
  /** Labelled boxes around groups of nodes, e.g. one per stage. */
  groups?: { label: string; nodes: string[]; tone?: Tone }[];
  /** Hand-written labels at a position in the drawing. */
  labels?: {
    /** `\n` breaks lines. */
    text: string;
    x: number;
    y: number;
    tone?: Tone;
    /** Hand-drawn arrows from the label to what it's about. */
    arrows?: { from: [number, number]; to: [number, number] }[];
  }[];
}

export interface CodeStep {
  kind: "code";
  title: string;
  notes: string;
  /** A row of options under the code, with the current one lit (as on roll slides). */
  reel?: { items: string[]; at: number };
  /** What the new lines add, in pyramid terms: tints them and labels them. */
  layer?: "resource" | "binding" | "api";
  /** Consecutive code steps in the same group morph into each other. */
  group: string;
  /** File name on the editor tab, or undefined for a pseudo-code block. */
  file?: string;
  /** The imagined language: labelled as such on screen. */
  pseudo?: boolean;
  lines: Token[][];
  fontSize: number;
  tints: { from: number; to: number; tone: Tone }[];
  focus?: { from: number; to: number };
  marks: Mark[];
  error?: CodeError;
  panel?: { title: string; items: PanelItem[] };
  diagram?: MiniGraph;
  /** The two phases over time, drawn where the diagram goes. */
  timeline?: PhaseTimeline;
  drill?: Drill;
  req?: ReqPanel;
  bundle?: BundlePanel;
  /** A second file shown side by side, on the right. */
  beside?: CodeStep;
  /** Lines from text in this pane to text in `beside`: how the two are coupled. */
  links?: CodeLink[];
  /** A file generated from this one, drawn under it with a labelled arrow, and its links to `beside`. */
  under?: { step: CodeStep; label: string; links?: CodeLink[] };
  /** Arcs from text in the code to what it becomes in `diagram`: a node, or an edge's label. */
  diagramLinks?: { from: Span; to: { node: string } | { edge: [string, string] }; tone?: Tone }[];
  /** A big hand-drawn red X across the code: this approach is wrong. */
  cross?: boolean;
  /** A hand-written aside in the bottom-right corner. */
  aside?: {
    text: string;
    tone?: Tone;
    /** A photo that pops in above the text: a path under `intro/assets/`. */
    image?: string;
    /** Bottom-left, beside the photo, for slides whose right side is full. */
    at?: "left" | "right";
  };
  /** No change highlight or spotlight on this step. */
  quiet?: boolean;
  /**
   * Per line: added (+, green) or removed (-, red) since this file was last on
   * screen. Removed lines are kept in `lines` so they can be shown. `start`/`end`
   * mark the part of a rewritten line that actually changed.
   */
  diff?: ({ kind: "add" | "del"; start?: number; end?: number } | null)[];
  frames: number;
}

export interface SlideStep {
  kind: "slide";
  title: string;
  notes: string;
  layout: "title" | "section";
  eyebrow?: string;
  heading: string;
  subtitle?: string;
  footer?: string;
  frames: number;
}

export interface BoardStep {
  kind: "board";
  title: string;
  notes: string;
  board: string;
  stage: number;
  frames: number;
}

/** A terminal pane: the command and the output shown so far (ANSI colours allowed). */
export interface TerminalStep {
  kind: "terminal";
  title: string;
  notes: string;
  group: string;
  /** Tab labels across the top; the active one is highlighted. */
  tabs?: string[];
  active?: number;
  lines: Token[][];
  /** Lines that are new since the previous step (they fade in). */
  fresh: number;
  /** A live deploy under the lines: each row moves pending → in progress → done on its own schedule. */
  progress?: {
    rows: { name: string; type?: string; binding?: boolean; from: number; to: number }[];
    /** Lines that appear once every row is done, at frame `at`. */
    done: Token[][];
    at: number;
  };
  frames: number;
}

/** A browser window showing one screenshot. */
export interface BrowserStep {
  kind: "browser";
  title: string;
  notes: string;
  url: string;
  image: string;
  frames: number;
}

/** The parts of the path from an edit to production (the loop deck's map). */
export type LoopPart =
  | "edit"
  | "types"
  | "local"
  | "live"
  | "push"
  | "pr"
  | "prTest"
  | "comment"
  | "merge"
  | "staging"
  | "stagingTest"
  | "prod"
  | "feedback";

/** The whole loop, drawn full screen, with some parts lit. */
export interface LoopStep {
  kind: "loop";
  title: string;
  notes: string;
  /** Parts drawn so far, for building the map up; omit to draw everything. */
  show?: LoopPart[];
  lit?: LoopPart[];
  focus?: LoopPart[];
  frames: number;
}

/** A pull request page: its checks, and comments (e.g. the preview link). */
export interface CommentStep {
  kind: "comment";
  title: string;
  notes: string;
  pr: { number: number; title: string; branch: string };
  checks: { name: string; state: "pending" | "passed" | "failed"; detail?: string }[];
  comments: { author: string; bot?: boolean; lines: string[] }[];
  frames: number;
}

/** One layer of an application, drawn as a band of the pyramid. */
export interface PyramidLayer {
  id: string;
  title: string;
  detail: string;
  color: string;
}

/** An application's layers as a pyramid, bottom first, with notes beside them. */
export interface PyramidStep {
  kind: "pyramid";
  title: string;
  notes: string;
  /** Layers drawn so far, bottom first. */
  layers: PyramidLayer[];
  /** Layers at full strength; the rest are dimmed. Omit to light everything. */
  lit?: string[];
  /** Hand-written notes to the right of a layer. */
  side?: {
    layer: string;
    text: string;
    tone?: Tone;
    /** Code set in a column right of the pyramid, instead of a hand-written note. */
    code?: boolean;
    /** The code, highlighted (filled in by the build). */
    tokens?: Token[][];
  }[];
  /** A column beside the pyramid, spanning every layer (observability). */
  pillar?: { title: string; lines: string[]; color: string };
  /** A bracket over every layer, with a label. */
  brace?: { text: string; sub?: string };
  /** A dashed line under a layer, splitting the stack into two programs. */
  cut?: { under: string; above: string; below: string };
  /** One feature, cut vertically through every layer: what it needs in each. */
  slice?: { label: string; items: Record<string, string> };
  /** Several features, each cut vertically through the layers, side by side. */
  slices?: { label: string; items: Record<string, string> }[];
  /** The stack rebuilt from modules: bricks laid in the pyramid's rows, bottom first. */
  bricks?: {
    row: number;
    title: string;
    detail: string;
    color: string;
    /** Fixed place in the row (0-based) out of `of`, so a row doesn't reflow as bricks arrive. */
    col?: number;
    of?: number;
  }[];
  frames: number;
}

/**
 * Code that stays put while a few spans of it roll to the next value, like a
 * slot machine: each keypress swaps a provider, and nothing else moves.
 */
export interface RollStep {
  kind: "roll";
  title: string;
  notes: string;
  /** Consecutive roll steps of one group animate from each other. */
  group: string;
  file?: string;
  fontSize: number;
  lines: Token[][];
  /** The spans that change between the steps of a group, by index. */
  slots: { line: number; start: number; end: number; active?: boolean }[];
  /** What the current code generates at deploy, beside it. */
  beside?: { file: string; lines: Token[][] };
  /** Every option in the roll, with the current one lit. */
  reel?: { items: string[]; at: number };
  /** Spin one slot through these values, slot-machine style, before it lands on its own. */
  spin?: { slot: number; through: string[]; reelFrom: number };
  frames: number;
}

/** A full-screen architecture drawing: boxes, and arrows between them. */
export interface ArchStep {
  kind: "arch";
  title: string;
  notes: string;
  nodes: {
    id: string;
    title: string;
    sub?: string;
    color: string;
    x: number;
    y: number;
    w?: number;
    h?: number;
  }[];
  /** Row labels down the left edge, so the drawing reads top to bottom. */
  lanes?: { label: string; y: number; color: string }[];
  /** `dashed` edges are telemetry, not requests. */
  /** `dashed` edges are telemetry; `elbow` edges leave sideways, then turn down. */
  edges: { from: string; to: string; label?: string; dashed?: boolean; elbow?: boolean }[];
  frames: number;
}

/** A mocked observability dashboard (hypothetical UI), optionally with its monitor firing. */
export interface DashStep {
  kind: "dash";
  title: string;
  notes: string;
  /** Show the monitor alert firing, and the error spike that triggered it. */
  alert?: boolean;
  frames: number;
}

export type IntroStep =
  | DashStep
  | ArchStep
  | RollStep
  | CodeStep
  | SlideStep
  | BoardStep
  | TerminalStep
  | BrowserStep
  | LoopStep
  | CommentStep
  | PyramidStep;

export interface IntroJson {
  steps: IntroStep[];
}

/** Frame ranges of each step, back to back. */
export const introTimeline = (steps: IntroStep[]) => {
  let from = 0;
  return steps.map((step) => {
    const range = { from, to: from + step.frames };
    from = range.to;
    return range;
  });
};
