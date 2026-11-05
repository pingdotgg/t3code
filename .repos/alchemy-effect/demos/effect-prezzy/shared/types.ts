/**
 * The contract between the capture step (which runs the demo for real) and
 * the Remotion compositions (which draw it). Capture writes one
 * `SceneCapture` per scene to `out/capture/<scene>/scene.json`; Remotion
 * reads it with `staticFile`. Asset paths are relative to `out/capture`,
 * which is Remotion's public directory.
 */

/** Size of the rendered video. Every layout constant derives from it. */
export const VIDEO = { width: 1920, height: 1080, fps: 30 } as const;

/** One desktop window; all windows share the same frame and stack by focus. */
export const WINDOW = { x: 80, y: 52, width: 1760, height: 900 } as const;
/** The caption band below the windows: captions live here and never cover content. */
export const CAPTION_BAND = {
  top: WINDOW.y + WINDOW.height,
  height: VIDEO.height - WINDOW.y - WINDOW.height,
} as const;
export const TITLE_BAR = 44;
/** Ghostty's native macOS tab bar, under the title bar. */
export const TAB_BAR = 34;
/** The terminal clip fills the window below its title and tab bars. */
export const TERMINAL = {
  width: WINDOW.width,
  height: WINDOW.height - TITLE_BAR - TAB_BAR,
} as const;
/** Chrome-style tab strip + toolbar above the page. */
export const BROWSER_CHROME = 92;
export const BROWSER_VIEWPORT = {
  width: WINDOW.width,
  height: WINDOW.height - BROWSER_CHROME,
} as const;

/** Terminal tabs: `alchemy deploy`, `pnpm test`, and the long-running `alchemy dev`. */
export type TerminalTab = "deploy" | "test" | "dev";

export type AppId = "editor" | "terminal" | "diagram" | "browser" | "slide";

/** The architecture, derived from Alchemy's state files. */
export interface Graph {
  /** The stage the graph was read from, e.g. `dev_sam`. */
  stage: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  /** Short resource kind, e.g. `Worker`, `D1 Database`. */
  kind: string;
  /** Who provides it: drives the node's colour. */
  provider: "cloudflare" | "neon" | "axiom" | "other";
  /** `local` under `alchemy dev` simulators, `cloud` when really deployed. */
  location: "local" | "cloud";
  /** Layout column, left to right: website → worker → bindings → backing services → dashboards. */
  tier: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "binding" | "reference" | "consumer";
  label: string;
  /** What the binding granted, as shown in the diagram's side panel. */
  grant?: string;
}

export type Beat =
  /** Bring a window to the front (Cmd-Tab). Other beats focus their own window implicitly. */
  | { kind: "focus"; app: AppId }
  /** Open (or switch to) a file tab. */
  | { kind: "editor.open"; file: string; content: string }
  /** A full-screen transition slide before building a significant piece. */
  | {
      kind: "slide";
      layout: "section" | "title" | "bullets";
      props: { eyebrow?: string; heading: string; subtitle?: string; bullets?: string[] };
    }
  /** The narration caption at the bottom of the screen; stays until the next caption. */
  | { kind: "caption"; text: string }
  /** Starts a new presenter step: everything until the next `step` plays on one press of →. */
  | { kind: "step"; title: string; notes: string }
  /** Apply one edit to a file, shown as a green/red diff (opens the file first if needed). */
  | { kind: "editor.patch"; file: string; title: string; before: string; after: string }
  /** Older captures: a whole-file change, shown like a patch. */
  | { kind: "editor.edit"; file: string; before: string; after: string }
  /** Delete a file: its tab closes and it leaves the explorer. */
  | { kind: "editor.delete"; file: string }
  /** Play `[start, end)` seconds of the scene's terminal clip. */
  | { kind: "terminal"; start: number; end: number }
  /** Show the architecture; `added` nodes and edges animate in. */
  | { kind: "diagram"; graph: Graph; addedNodes: string[]; addedEdges: string[] }
  /** Type `url` into the address bar and show the captured page. */
  | { kind: "browser"; url: string; title: string; screenshot: string }
  /** The pointer moves to `target` (page pixels) and fills or clicks it; the page then shows `screenshot`. */
  | {
      kind: "browser.action";
      action: "fill" | "click";
      target: { x: number; y: number; width: number; height: number };
      title: string;
      screenshot: string;
    }
  /** The open page changes in place (live updates). */
  | { kind: "browser.update"; title: string; screenshot: string }
  /** Hold on the current picture. */
  | { kind: "pause"; seconds: number };

export interface BrowserPage {
  url: string;
  title: string;
  screenshot: string;
}

/** Window contents when a scene starts or ends. */
export interface Desk {
  files: string[];
  tabs: { file: string; content: string }[];
  active?: string;
  browser?: BrowserPage;
  diagram?: Graph;
  /** Terminal tabs opened so far, in the order they were opened. */
  terminalTabs?: TerminalTab[];
}

export interface SceneCapture {
  id: string;
  title: string;
  notes: string;
  /** Project folder name shown in the explorer and title bars. */
  project: string;
  /** Windows when the scene starts. */
  start: Desk;
  /** Windows when the scene ends; the next scene starts from here. */
  end: Desk;
  /** Terminal-only render of the scene's shell session. */
  terminal:
    | {
        clip: string;
        duration: number;
        /** Which tab is on screen from each clip time on (marked once the screen has repainted). */
        tabs: { at: number; tab: TerminalTab }[];
        /** Clip times where output resumes after a pause: the presenter stops just before each. */
        pauses?: number[];
      }
    | undefined;
  beats: Beat[];
}

/** Title-card style slides, designed in React and placed between scenes. */
export interface SlideItem {
  kind: "slide";
  id: string;
  title: string;
  notes: string;
  layout: "title" | "section" | "bullets";
  props: {
    eyebrow?: string;
    heading: string;
    subtitle?: string;
    footer?: string;
    bullets?: string[];
  };
  /** Seconds the slide animates before holding. */
  seconds?: number;
}

export interface SceneItem {
  kind: "scene";
  /** Matches `scenes/<id>.ts`. */
  id: string;
}

/** The story-telling intro (`intro/steps.ts`), one presenter step per intro step. */
export interface IntroItem {
  kind: "intro";
  /** The deck's folder under out/capture (`intro` or `loop`). */
  id: "intro" | "loop";
}

export type DeckItem = SlideItem | SceneItem | IntroItem;
