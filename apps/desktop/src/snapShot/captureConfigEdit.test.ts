import { describe, expect, it } from "vite-plus/test";
import {
  captureConfigBinding,
  editCaptureConfig,
  niriConfigConflict,
  niriConfigIncludes,
} from "./captureConfigEdit.ts";
import { readKdlNodes } from "./captureConfigKdl.ts";

const app = "com.t3tools.T3Code";
const binding = captureConfigBinding("niri", app, "Ctrl+Shift+2");

describe("Niri capture config edits", () => {
  it("inserts into the existing top-level binds, preserving unrelated text", () => {
    const before =
      '// My desktop\ninput { keyboard { xkb { layout "us"; }; }; }\nbinds {\n    Mod+Q { spawn "kitty"; } // keep me\n}\n';
    const result = editCaptureConfig(before, "niri", app, "install");
    expect(result.after).toBe(before.replace("\n}\n", `\n    ${binding}\n}\n`));
    expect(readKdlNodes(result.after).filter((node) => node.name === "binds")).toHaveLength(1);
  });
  it("ignores commented, nested, and string-valued binds and braces", () => {
    const before = `// binds { fake\n/* binds { /* nested */ } */\n/- binds { Ctrl+Shift+2 { quit; } }\nrecent-windows { binds { Alt+Tab { next-window; } }; }\nspawn-at-startup "echo" r#"binds { }"#\n"binds" {\n    Mod+Q { spawn "a } \\" b"; }\n}\n`;
    // A quoted brace in a valid shell argument must not close the binds section.
    const valid = before.replace('"a } \\" b"', '"a } b"');
    const result = editCaptureConfig(valid, "niri", app, "install");
    expect(result.after).toContain(`    ${binding}\n}\n`);
    expect(result.after.startsWith(valid.slice(0, valid.indexOf('"binds" {')))).toBe(true);
  });
  it.each(["binds {}", "binds { Mod+Q { quit; }; }", "input { }\n", ""])(
    "handles compact or absent binds: %s",
    (before) => {
      const result = editCaptureConfig(before, "niri", app, "install");
      const block = readKdlNodes(result.after).find((node) => node.name === "binds")!;
      expect(block.children.some((node) => node.name === "Ctrl+Shift+2")).toBe(true);
    },
  );
  it("preserves CRLF and the UTF-8 BOM", () => {
    const before = "\uFEFFbinds {\r\n}\r\n";
    expect(editCaptureConfig(before, "niri", app, "install").after).toBe(
      `\uFEFFbinds {\r\n    ${binding}\r\n}\r\n`,
    );
  });
  it("preserves Unicode spacing around nodes and line continuations", () => {
    const spaces =
      "\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000";
    const before = `binds${spaces}\\${spaces}\n{\n}\n`;
    expect(editCaptureConfig(before, "niri", app, "install").after).toBe(
      before.replace("}\n", `    ${binding}\n}\n`),
    );
  });
  it("does not duplicate an existing binding, including a custom chord", () => {
    const before = `binds {\n    ${binding.replace("Ctrl+Shift+2", "Alt+Ctrl+Y")}\n}\n`;
    const result = editCaptureConfig(before, "niri", app, "install");
    expect(result.after).toBe(before);
    expect(result.shortcut).toBe("Ctrl+Alt+Y");
  });
  it("replaces and removes only this app's capture binding", () => {
    const other = captureConfigBinding("niri", "com.t3tools.Other", "Ctrl+Alt+4");
    const before = `binds {\n    ${binding}\n    ${other}\n}\n`;
    const result = editCaptureConfig(before, "niri", app, "install", "Ctrl+Alt+Y");
    expect(result.after).toContain(other);
    expect(result.after).not.toContain("Ctrl+Shift+2");
    expect(result.after).toContain("Ctrl+Alt+Y");
    const removed = editCaptureConfig(result.after, "niri", app, "remove");
    expect(removed.after).toBe(`binds {\n    ${other}\n}\n`);
  });
  it("refuses occupied keys regardless of modifier order, without removing them", () => {
    const before = "binds { Shift+Control+2 { quit; } }";
    expect(niriConfigConflict(before, app, "Ctrl+Shift+2")).toBe(true);
    expect(() => editCaptureConfig(before, "niri", app, "install")).toThrow("already used");
  });
  it("does not count a slash-dash-disabled key as occupied", () => {
    expect(niriConfigConflict("binds { /- Ctrl+Shift+2 { quit; }; }", app, "Ctrl+Shift+2")).toBe(
      false,
    );
  });
  it.each(["binds {", "binds {}\nbinds {}", "/* unfinished", 'spawn "unfinished'])(
    "fails safely for malformed structure: %s",
    (source) => {
      expect(() => editCaptureConfig(source, "niri", app, "install")).toThrow();
    },
  );
  it("reads only real top-level include directives", () => {
    expect(
      niriConfigIncludes(
        '// include "no"\n/- include "no"\ninclude "keys.kdl"\ninclude optional=true "extra.kdl"',
      ),
    ).toEqual([
      { path: "keys.kdl", optional: false },
      { path: "extra.kdl", optional: true },
    ]);
  });
});

describe("Hyprland capture config edits", () => {
  it.each(["hyprland", "hyprland-lua"] as const)(
    "is idempotent and reversible for %s",
    (format) => {
      const before =
        format === "hyprland"
          ? "# Keep my preferences\n$mainMod = SUPER\n"
          : "-- Keep my preferences\nhl.config({ general = { border_size = 2 } })\n";
      const added = editCaptureConfig(before, format, app, "install");
      expect(added.after.startsWith(before)).toBe(true);
      expect(editCaptureConfig(added.after, format, app, "install").after).toBe(added.after);
      const changed = editCaptureConfig(added.after, format, app, "install", "Ctrl+Alt+Y");
      expect(changed.after).not.toContain(captureConfigBinding(format, app, "Ctrl+Shift+2"));
      expect(changed.after).toContain(captureConfigBinding(format, app, "Ctrl+Alt+Y"));
      expect(editCaptureConfig(changed.after, format, app, "remove").after.trim()).toBe(
        before.trim(),
      );
    },
  );
  it("does not steal an existing legacy shortcut", () => {
    expect(() =>
      editCaptureConfig("bind = SHIFT CTRL, 2, exec, kitty\n", "hyprland", app, "install"),
    ).toThrow("already used");
  });
  it("leaves commented bindings alone", () => {
    const before = "# bind = CTRL SHIFT, 2, global, com.t3tools.T3Code:capture-window\n";
    expect(editCaptureConfig(before, "hyprland", app, "remove").after).toBe(before);
  });
  it.each([
    "return {}",
    '--[[\nhl.bind("CTRL + SHIFT + 2", hl.dsp.global("com.t3tools.T3Code:capture-window"))\n]]',
  ])("does not guess how to edit complex Lua", (source) => {
    expect(() => editCaptureConfig(source, "hyprland-lua", app, "install")).toThrow("manual edit");
  });
  it.each(['Ctrl+"\nexec', "Ctrl+;", "2", "Mod+2"])(
    "rejects unsafe or ambiguous keys: %s",
    (keys) => {
      expect(() => editCaptureConfig("", "hyprland", app, "install", keys)).toThrow();
    },
  );
});
