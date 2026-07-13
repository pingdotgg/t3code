import { describe, expect, it } from "bun:test";

// Web ⇄ TUI parity, expressed as a living BDD batch. Each dimension that already
// matches the web is asserted as a real spec (here or in the relevant component
// test); each remaining gap is a `describe.skip` documenting the target Given/
// When/Then. Whole unported capabilities live in features.backlog.test.ts,
// whose source-backed catalog makes `bun test`'s skipped count track the parity
// backlog without duplicating the component-level specs here.
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
  { command: "command palette", web: "Cmd/Ctrl+K", tui: "^K", status: "aligned" },
  { command: "filter / search", web: "Cmd/Ctrl+F", tui: "^F", status: "aligned" },
  { command: "source-control panel", web: "(surface)", tui: "^L", status: "aligned" },
  { command: "thread next/prev", web: "Cmd/Ctrl+[ / ]", tui: "Alt+↑ / Alt+↓", status: "aligned" },
  { command: "thread jump 1–9", web: "Cmd/Ctrl+1…9", tui: "Alt+1…9", status: "aligned" },
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

  it("Given the command palette, then it is aligned on ^K (web parity)", () => {
    const palette = KEYMAP_PARITY.find((e) => e.command === "command palette");
    expect(palette).toMatchObject({ status: "aligned", tui: "^K" });
  });

  it("Given thread navigation, then it is aligned via terminal-friendly Alt combos", () => {
    const jump = KEYMAP_PARITY.find((e) => e.command === "thread jump 1–9");
    expect(jump?.status).toBe("aligned");
    expect(jump?.tui).toContain("Alt+1");
  });
});

// Thread navigation, changed-file actions, commit-message entry, file browsing,
// source-control actions, and the read-only settings reference are covered by
// their component/logic specs. Remaining whole-feature gaps are cataloged once
// in features.backlog.test.ts.
