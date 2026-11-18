// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/fake.ts), modified for Ada.
import { MacControls } from "./macControls.ts";
import type { ComputerControl } from "./macControls.ts";
import { NeedsPointer } from "./types.ts";
import type {
  ActOptions,
  ActResult,
  Observation,
  Point,
  Rect,
  ScreenAction,
  ScreenBackend,
  ScreenControl,
} from "./types.ts";

/**
 * A deterministic, in-memory Mac for tests: a scripted Notes-like app (a search field, the buttons "New Note",
 * "Delete" and "Send", and a list of notes) where every action changes what the next observation shows, so a task
 * such as "search for groceries" can actually finish. Nothing here touches the real screen.
 */
const SPOTS: Record<string, Point> = {
  search: { x: 200, y: 80 },
  new: { x: 500, y: 80 },
  delete: { x: 560, y: 80 },
  send: { x: 620, y: 80 },
};

export class FakeNotes implements ScreenBackend {
  readonly kind = "desktop";
  readonly notes: string[] = ["Groceries: milk, eggs, bread", "Trip ideas", "Team meeting notes"];
  /** Every action, in order. */
  readonly actions: ScreenAction[] = [];
  /** Titles of the notes "sent". */
  readonly sent: string[] = [];
  query = "";
  searched = false;
  selected: number | null = null;
  /** The open context menu's items, and the items picked from one. */
  menu: string[] = [];
  /** Whether the list scrolls, and how many pages down it is. */
  scrollable = false;
  page = 0;
  readonly picked: string[] = [];
  private focus: "search" | null = null;
  private at: Point = { x: 400, y: 300 };

  async observe(): Promise<Observation> {
    const visible = this.visible();
    const search: ScreenControl = {
      ref: "search",
      role: "textbox",
      label: "Search",
      value: this.query,
    };
    if (this.focus === "search") search.focused = true;
    const controls: ScreenControl[] = [
      search,
      { ref: "new", role: "button", label: "New Note" },
      { ref: "delete", role: "button", label: "Delete" },
      { ref: "send", role: "button", label: "Send" },
      ...visible.map((index): ScreenControl => ({
        ref: `note.${index}`,
        role: "row",
        label: this.notes[index] ?? "",
      })),
    ];
    const title = this.searched
      ? `Notes – ${visible.length} found for “${this.query}”`
      : this.selected !== null && this.notes[this.selected] !== undefined
        ? `Notes – ${this.notes[this.selected]}`
        : "Notes";
    const text = this.searched
      ? `Search results for “${this.query}”: ${visible.map((index) => this.notes[index]).join("; ") || "no notes match"}`
      : `${this.notes.length} notes${this.page ? `, page ${this.page + 1}` : ""}`;
    return {
      backend: "desktop",
      app: "Notes",
      title,
      controls,
      text,
      ...(this.menu.length ? { popup: this.menu.join(" | ") } : {}),
    };
  }

  /** Refs that cannot be acted on in the background (a canvas): acting on them needs the person's mouse. */
  readonly pointerOnly = new Set<string>();
  /** How each action was done, in order. */
  readonly modes: Array<"background" | "pointer"> = [];

  /** Acts like an accessibility action: the real pointer stays where the person has it, and `at` says where it acted. */
  async act(action: ScreenAction, options: ActOptions = {}): Promise<ActResult> {
    const ref = "ref" in action ? action.ref : undefined;
    const pointer = ref !== undefined && this.pointerOnly.has(ref);
    if (pointer && !options.allowPointer)
      throw new NeedsPointer("that control draws itself and has no accessible action");
    this.actions.push(action);
    const mode = pointer ? "pointer" : "background";
    this.modes.push(mode);
    const done = (at: Point | undefined): ActResult => {
      if (pointer && at) this.at = at;
      return { mode, ...(at ? { at } : {}), ...(pointer && at ? { pointer: at } : {}) };
    };
    switch (action.kind) {
      case "click": {
        const point = this.spot(action.ref);
        this.click(action.ref);
        return done(point);
      }
      case "type": {
        if (action.ref !== "search") throw new Error("That control is gone; look again.");
        const point = this.spot(action.ref);
        this.query = action.text;
        this.searched = false;
        this.focus = "search";
        return done(point);
      }
      case "press":
        // Like a browser's saved sign-ins, down in the focused box opens its suggestions.
        if (action.key === "down" && this.focus === "search")
          this.menu = ["Password for dana@acme.test"];
        if (action.key === "enter" && this.focus === "search" && this.query) this.searched = true;
        if (action.key === "escape") {
          this.query = "";
          this.searched = false;
        }
        return done(undefined);
      case "scroll":
        if (this.scrollable)
          this.page = Math.max(
            0,
            this.page + (action.direction === "up" ? -1 : 1) * (action.amount ?? 1),
          );
        return done({ x: 400, y: 300 });
      case "menu":
        this.menu = action.ref === "search" ? ["Paste", "Select password"] : [];
        return done(this.spot(action.ref));
      case "pick":
        if (!this.menu.includes(action.label))
          throw new Error("That menu item is gone; look again.");
        this.picked.push(action.label);
        // Like a browser's "Select password", one item opens a picker of saved accounts.
        this.menu = action.label === "Select password" ? ["Password for dana@acme.test"] : [];
        return done(undefined);
    }
  }

  async pointer(): Promise<Point> {
    return { ...this.at };
  }

  /** One 1440×900 display, as on a 14-inch MacBook. */
  async displays(): Promise<Rect[]> {
    return [{ x: 0, y: 0, w: 1440, h: 900 }];
  }

  /** The person moves the pointer (for tests of the local stop). */
  movePointer(point: Point) {
    this.at = { ...point };
  }

  private visible(): number[] {
    const wanted = this.query.trim().toLowerCase();
    return this.notes
      .map((_, index) => index)
      .filter((index) => !wanted || (this.notes[index] ?? "").toLowerCase().includes(wanted));
  }

  /** Where a control is on the fake screen; a control not on it now is gone. */
  private spot(ref: string): Point {
    const fixed = SPOTS[ref];
    if (fixed) return fixed;
    const row = /^note\.(\d+)$/.exec(ref);
    const index = row ? Number(row[1]) : -1;
    if (!this.visible().includes(index)) throw new Error("That control is gone; look again.");
    return { x: 200, y: 140 + 30 * this.visible().indexOf(index) };
  }

  private click(ref: string) {
    if (ref === "search") {
      this.focus = "search";
      return;
    }
    this.focus = null;
    if (ref === "new") {
      this.notes.push("New Note");
      this.query = "";
      this.searched = false;
      this.selected = this.notes.length - 1;
    } else if (ref === "delete") {
      if (this.selected !== null) this.notes.splice(this.selected, 1);
      this.selected = null;
    } else if (ref === "send") {
      if (this.selected !== null && this.notes[this.selected] !== undefined)
        this.sent.push(this.notes[this.selected] ?? "");
    } else {
      this.selected = Number(ref.slice("note.".length));
    }
  }
}

/** Fixed controls that only record what they were asked, and the task-start notices. */
export class FakeControls {
  readonly calls: ComputerControl[] = [];
  readonly notices: Array<{ title: string; text: string }> = [];
  private readonly words = new MacControls({ platform: "darwin", runner: { run: async () => "" } });

  async run(control: ComputerControl): Promise<{ done: string }> {
    this.calls.push(control);
    return { done: `Pretended to ${this.words.describe(control)} (fake Mac).` };
  }

  async notify(title: string, text: string): Promise<void> {
    this.notices.push({ title, text });
  }
}

/** A whole fake Mac: the Notes app in front, a Dock with Notes in it, and fixed controls. */
export function fakeMac() {
  const desktop = new FakeNotes();
  const controls = new FakeControls();
  const brought: string[] = [];
  return {
    desktop,
    controls,
    brought,
    dock: {
      list: async () => ["Notes"],
      activate: async (name: string) => void brought.push(name),
    },
    apps: {
      running: async () => ["Notes"],
      activate: async (name: string) => void brought.push(name),
    },
  };
}
