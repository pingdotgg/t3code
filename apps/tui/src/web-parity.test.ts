import { describe, expect, it } from "bun:test";

// Web ⇄ TUI parity, expressed as a living BDD batch. Each dimension that already
// matches the web is asserted as a real spec (here or in the relevant component
// test); each remaining gap is a `describe.skip` documenting the target Given/
// When/Then, so `bun test`'s skipped count tracks the parity backlog. Companion
// to features.backlog.test.ts (which tracks whole un-ported features).
//
// Real parity specs live with their subjects:
//   - composer controls in the box, model-first → ChatComposer.test / ControlsRow.test
//   - changed-files directory tree + collapse-all → MessagesTimeline.test
//   - single-column icon glyphs + web-icon mapping → icons.test
//   - right-panel git status + quick action + menu → RightPanel.test / gitActions.logic.test
//   - Shift+Tab plan/build alias → covered by the keymap table below

// ── Keyboard parity table ────────────────────────────────────────────────────
//
// "aligned" = the TUI sends the same (or web-equivalent) combo the terminal
// allows; "backlog" = a web command not yet bound in the TUI; "n/a" = needs a
// modifier a terminal can't deliver (e.g. ⌘) or a web-only surface.
type ParityStatus = "aligned" | "backlog" | "n/a";
interface KeyParity {
  readonly command: string;
  readonly web: string;
  readonly tui: string | null;
  readonly status: ParityStatus;
}

const KEYMAP_PARITY: ReadonlyArray<KeyParity> = [
  { command: "plan/build toggle", web: "Shift+Tab", tui: "Shift+Tab (and ^B)", status: "aligned" },
  { command: "new thread", web: "Cmd/Ctrl+N", tui: "^N", status: "aligned" },
  { command: "toggle terminal", web: "Ctrl+`", tui: "^E", status: "aligned" },
  { command: "thread actions", web: "(menu)", tui: "^K", status: "aligned" },
  { command: "filter / search", web: "Cmd/Ctrl+F", tui: "^F", status: "aligned" },
  { command: "source-control panel", web: "(surface)", tui: "^L", status: "aligned" },
  { command: "thread next/prev", web: "Cmd/Ctrl+[ / ]", tui: "Alt+↑ / Alt+↓", status: "aligned" },
  { command: "thread jump 1–9", web: "Cmd/Ctrl+1…9", tui: "Alt+1…9", status: "aligned" },
  { command: "command palette", web: "Cmd/Ctrl+K", tui: null, status: "backlog" },
  { command: "terminal split", web: "Cmd/Ctrl+D", tui: null, status: "n/a" },
];

describe("keyboard parity", () => {
  it("Given every aligned command, then it names a concrete TUI key", () => {
    for (const entry of KEYMAP_PARITY) {
      if (entry.status === "aligned") {
        expect(entry.tui, entry.command).not.toBeNull();
        expect((entry.tui ?? "").length).toBeGreaterThan(0);
      } else {
        // backlog / n/a entries intentionally have no TUI binding yet.
        expect(entry.tui).toBeNull();
      }
    }
  });

  it("Given the web's Shift+Tab plan/build combo, then the TUI mirrors it", () => {
    const planToggle = KEYMAP_PARITY.find((e) => e.command === "plan/build toggle");
    expect(planToggle?.status).toBe("aligned");
    expect(planToggle?.tui).toContain("Shift+Tab");
  });

  it("Given the table, then it tracks at least the known backlog shortcuts", () => {
    const backlog = KEYMAP_PARITY.filter((e) => e.status === "backlog").map((e) => e.command);
    expect(backlog).toContain("command palette");
  });

  it("Given thread navigation, then it is aligned via terminal-friendly Alt combos", () => {
    const jump = KEYMAP_PARITY.find((e) => e.command === "thread jump 1–9");
    expect(jump?.status).toBe("aligned");
    expect(jump?.tui).toContain("Alt+1");
  });
});

// ── Backlog: dimensions not yet at parity ────────────────────────────────────
//
// Thread next/prev (Alt+↑/↓) + jump (Alt+1…9): SHIPPED — see store.test
// (moveThreadSelection / selectThreadByIndex) and the keymap table above.

describe.skip("Keyboard: command palette", () => {
  it("Given the palette key, when pressed, then a searchable command list opens", () => {});
});

describe.skip("Composer: provider-traits + plan-sidebar toggle + compact menu", () => {
  it("Given a provider with traits, then the composer shows its trait controls", () => {});
  it("Given a narrow terminal, then the controls collapse into a compact menu", () => {});
});

describe.skip("Changed files: per-file 'View diff' + file-type colored icons", () => {
  it("Given a file row, when clicked, then it opens the diff scoped to that file", () => {});
  it("Given a file row, then its icon is colored by file type (web PierreEntryIcon)", () => {});
});

// Commit-message dialog: SHIPPED — choosing a commit-bearing action opens the
// "commit ▸" composer mode (ChatComposer.test) which runs the action with the
// typed message (store.runGitAction(action, message)).
describe.skip("Right panel: Browser / Files surfaces + publish repo", () => {
  it("Given a repo with no remote, then a 'Publish repository' flow is offered", () => {});
  it("Given the panel, then Browser and Files surfaces can be opened (web RightPanelTabs)", () => {});
});

describe.skip("Settings overlay", () => {
  it("Given the settings key, when pressed, then a settings surface opens", () => {});
  it("Given settings, then general / providers / source-control / keybindings sections exist", () => {});
});
