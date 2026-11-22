import type { AppId, TerminalTab as Pane } from "../shared/types.ts";

export type { Pane };

export interface Term {
  /** Enter a command into a tab (it appears at once) and press Enter. */
  type(pane: Pane, command: string): Promise<void>;
  /** Press a key in a tab, e.g. `Enter`. */
  key(pane: Pane, key: string): Promise<void>;
  /** Run a command in a tab and wait for it to finish (or for `until`). Returns the tab text. */
  run(pane: Pane, command: string, opts?: { until?: RegExp; timeout?: number }): Promise<string>;
  /** Switch to the dev tab and wait until `alchemy dev` has settled after a change. */
  waitDev(opts?: { timeout?: number }): Promise<void>;
  /** Wait until a tab shows `pattern`. */
  waitFor(pane: Pane, pattern: RegExp, opts?: { timeout?: number }): Promise<string>;
  /** Current text of a tab, including scrollback. */
  text(pane: Pane): Promise<string>;
  sleep(ms: number): Promise<void>;
}

/** A single code edit: takes the file's current text, returns the next. */
export type Edit = (code: string) => string;

/**
 * What a chapter scene can do. Every call has a real effect on the project
 * folder, the terminal or the network, and is also recorded as a beat for
 * the video: patched files are written to disk before the next terminal
 * beat, terminal commands run in a real tmux session, and pages are real
 * captures. At the end of the scene every project file must match
 * `chapters/<chapter>`, so the edits can't drift from the tested code.
 */
export interface SceneContext {
  /** Absolute path of the project folder the demo builds. */
  readonly dir: string;
  /** Values passed to later scenes (e.g. a deployed URL). */
  readonly state: Record<string, string>;
  /** Copy every file of this scene's chapter into the project, except the ones edited on screen. */
  sync(opts?: { except?: string[] }): Promise<void>;
  /**
   * Lines of a file as it is at the end of this chapter: `L(3, 8)` is lines
   * 3–8 (1-based, inclusive) with a trailing newline. Handy for building
   * patches that end exactly at the real code.
   */
  chapterLines(file: string): Promise<(from: number, to?: number) => string>;
  /** Override the caption at the bottom of the screen (by default each step's title is its caption). */
  caption(text: string): void;
  /** A full-screen transition slide, as its own step, before building a significant piece. */
  slide(heading: string, opts?: { eyebrow?: string; subtitle?: string; notes?: string }): void;
  /** Start a new presenter step; it plays when the presenter presses →. Its title is shown as the caption. */
  step(title: string, notes?: string): void;
  editor: {
    /** Open a file in a tab (or switch to its tab). */
    open(file: string): Promise<void>;
    /** One edit to a file, as its own presenter step, shown as a green/red diff. `title` is its caption. */
    patch(file: string, title: string, edit: Edit, notes?: string): Promise<void>;
    /** The file's whole change to the chapter's version, as one patch step. */
    show(file: string, title?: string): Promise<void>;
    /** Delete a file (closes its tab). */
    remove(file: string): Promise<void>;
  };
  /** Drive the terminal; everything inside is shown in the terminal window. */
  terminal<T>(fn: (t: Term) => Promise<T>): Promise<T>;
  /** Show alchemy dev picking up the change, then the architecture read from Alchemy's state. */
  diagram(opts: { stage: string; nodes?: string[]; edges?: string[] }): Promise<void>;
  browser: {
    /** Load `url` in a real browser and show it. */
    open(url: string, opts?: { waitFor?: RegExp }): Promise<void>;
    /** Re-capture the open page once it shows `waitFor` (live updates). */
    update(opts: { waitFor: RegExp }): Promise<void>;
    /** Type `text` into a field, as a user would (shown with the pointer). */
    fill(selector: string, text: string): Promise<void>;
    /** Click an element and wait for the page to show `waitFor`. */
    click(selector: string, opts?: { waitFor?: RegExp }): Promise<void>;
  };
  /** Cmd-Tab to a window without doing anything in it. */
  focus(app: AppId): void;
  /** Hold on the current picture. */
  pause(seconds: number): void;
}

export interface SceneDefinition {
  title: string;
  notes?: string;
  /** Folder under `chapters/` this scene ends at. */
  chapter: string;
  run(s: SceneContext): Promise<void>;
}

export const defineScene = (scene: SceneDefinition): SceneDefinition => scene;

const locate = (code: string, anchor: string) => {
  const at = code.indexOf(anchor);
  if (at < 0) throw new Error(`edit anchor not found:\n${anchor}\n--- in ---\n${code}`);
  if (code.indexOf(anchor, at + 1) >= 0) throw new Error(`edit anchor is ambiguous:\n${anchor}`);
  return at;
};

/** Edit helpers. Anchors must match exactly once, so a stale edit fails loudly. */
export const edit = {
  /** Replace the whole file. */
  set:
    (text: string): Edit =>
    () =>
      text,
  /** Add text at the end of the file. */
  append:
    (text: string): Edit =>
    (code) =>
      code + text,
  /** Insert `text` right after `anchor`. */
  after:
    (anchor: string, text: string): Edit =>
    (code) => {
      const at = locate(code, anchor) + anchor.length;
      return code.slice(0, at) + text + code.slice(at);
    },
  /** Insert `text` right before `anchor`. */
  before:
    (anchor: string, text: string): Edit =>
    (code) => {
      const at = locate(code, anchor);
      return code.slice(0, at) + text + code.slice(at);
    },
  /** Replace `anchor` with `text`. */
  replace:
    (anchor: string, text: string): Edit =>
    (code) => {
      const at = locate(code, anchor);
      return code.slice(0, at) + text + code.slice(at + anchor.length);
    },
  /** Apply several edits as one patch. */
  all:
    (...edits: Edit[]): Edit =>
    (code) =>
      edits.reduce((acc, e) => e(acc), code),
};
