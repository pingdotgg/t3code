import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, afterEach, describe, expect, it, vi } from "vitest";

import {
  compileResolvedKeybindingRule,
  parseKeybindingShortcut,
  upsertKeybindingRule,
} from "./keybindings";

describe("server keybindings", () => {
  const tempDirs: string[] = [];
  const logger = {
    warn: vi.fn(),
  };

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    logger.warn.mockReset();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses shortcuts including plus key", () => {
    assert.deepEqual(parseKeybindingShortcut("mod+j"), {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
    assert.deepEqual(parseKeybindingShortcut("mod++"), {
      key: "+",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
  });

  it("compiles valid rule with parsed when AST", () => {
    const compiled = compileResolvedKeybindingRule({
      key: "mod+d",
      command: "terminal.split",
      when: "terminalOpen && !terminalFocus",
    });

    assert.deepEqual(compiled, {
      command: "terminal.split",
      shortcut: {
        key: "d",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: {
        type: "and",
        left: { type: "identifier", name: "terminalOpen" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
    });
  });

  it("rejects invalid rules", () => {
    assert.isNull(
      compileResolvedKeybindingRule({
        key: "mod+shift+d+o",
        command: "terminal.new",
      }),
    );

    assert.isNull(
      compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalFocus && (",
      }),
    );

    assert.isNull(
      compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: `${"!".repeat(300)}terminalFocus`,
      }),
    );
  });

  it("upserts custom keybindings to ~/.t3/keybindings.json", () => {
    const fakeHome = makeTempDir("t3code-keybindings-upsert-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "keybindings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    const resolved = upsertKeybindingRule(logger, {
      key: "mod+shift+r",
      command: "script.run-tests.run",
    });
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as Array<{
      key: string;
      command: string;
    }>;

    expect(persisted).toEqual([
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+shift+r", command: "script.run-tests.run" },
    ]);
    expect(resolved.some((entry) => entry.command === "script.run-tests.run")).toBe(true);
  });

  it("replaces existing custom keybinding for the same command", () => {
    const fakeHome = makeTempDir("t3code-keybindings-upsert-replace-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "keybindings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify([{ key: "mod+r", command: "script.run-tests.run" }]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    upsertKeybindingRule(logger, {
      key: "mod+shift+r",
      command: "script.run-tests.run",
    });

    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as Array<{
      key: string;
      command: string;
    }>;
    expect(persisted).toEqual([{ key: "mod+shift+r", command: "script.run-tests.run" }]);
  });

  it("refuses to overwrite malformed keybindings config", () => {
    const fakeHome = makeTempDir("t3code-keybindings-malformed-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "keybindings.json");
    fs.writeFileSync(configPath, "{ not-json", "utf8");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    expect(() =>
      upsertKeybindingRule(logger, {
        key: "mod+shift+r",
        command: "script.run-tests.run",
      }),
    ).toThrow(/Unable to parse keybindings config/);

    expect(fs.readFileSync(configPath, "utf8")).toBe("{ not-json");
  });

  it("cleans up temp files when atomic keybinding write fails", () => {
    const fakeHome = makeTempDir("t3code-keybindings-atomic-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "keybindings.json");
    fs.writeFileSync(configPath, JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]), "utf8");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });

    expect(() =>
      upsertKeybindingRule(logger, {
        key: "mod+shift+r",
        command: "script.run-tests.run",
      }),
    ).toThrow(/rename failed/);

    expect(fs.readFileSync(configPath, "utf8")).toBe(
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]),
    );
    const tempFiles = fs
      .readdirSync(configDir)
      .filter((file) => file.includes("keybindings.json.") && file.endsWith(".tmp"));
    expect(tempFiles).toEqual([]);
  });
});
