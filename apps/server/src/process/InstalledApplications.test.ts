import { assert, describe, it } from "@effect/vitest";

import {
  parseDesktopEntry,
  parseExec,
  PROJECT_PATH_SLOT,
  withProjectPath,
} from "./InstalledApplications.ts";

describe("parseExec", () => {
  it("marks where the project path goes, in place", () => {
    // Appending instead would launch `editor --new-window <path>`, reordering
    // the application's own arguments.
    assert.deepEqual(parseExec("editor %F --new-window"), [
      "editor",
      PROJECT_PATH_SLOT,
      "--new-window",
    ]);
  });

  it("drops non-path field codes and collapses repeated path codes", () => {
    assert.deepEqual(parseExec("app %f %u %i %c --real"), ["app", PROJECT_PATH_SLOT, "--real"]);
  });

  it("honours quotes and backslash escapes", () => {
    assert.deepEqual(parseExec('"/opt/My App/run" --flag'), ["/opt/My App/run", "--flag"]);
    assert.deepEqual(parseExec("/opt/My\\ App/run"), ["/opt/My App/run"]);
    assert.deepEqual(parseExec('"/opt/a\\"b" x'), ['/opt/a"b', "x"]);
  });
});

describe("parseDesktopEntry", () => {
  const entry = (body: string) => `[Desktop Entry]\n${body}\n`;

  it("reads a typical application entry", () => {
    assert.deepEqual(
      parseDesktopEntry(entry("Name=Antigravity\nExec=/usr/bin/agy %F\nType=Application")),
      { name: "Antigravity", command: "/usr/bin/agy", args: [PROJECT_PATH_SLOT] },
    );
  });

  it("skips entries that are hidden, terminal, non-application, or incomplete", () => {
    for (const suffix of ["NoDisplay=true", "Hidden=true", "Terminal=true"]) {
      assert.isNull(parseDesktopEntry(entry(`Name=A\nExec=a\nType=Application\n${suffix}`)));
    }
    assert.isNull(parseDesktopEntry(entry("Name=Docs\nExec=x\nType=Link")));
    assert.isNull(parseDesktopEntry(entry("Name=A\nType=Application")));
  });

  it("prefers the unlocalized name and ignores [Desktop Action] groups", () => {
    const parsed = parseDesktopEntry(
      "[Desktop Entry]\nName[de]=DE\nName=Main\nExec=main\n\n[Desktop Action n]\nName=N\nExec=other\n",
    );
    assert.deepEqual(parsed, { name: "Main", command: "main", args: [] });
  });
});

describe("withProjectPath", () => {
  it("replaces the slot, or appends when there is none", () => {
    assert.deepEqual(withProjectPath(["--new", PROJECT_PATH_SLOT, "--wait"], "/repo"), [
      "--new",
      "/repo",
      "--wait",
    ]);
    assert.deepEqual(withProjectPath(["--wait"], "/repo"), ["--wait", "/repo"]);
  });
});
