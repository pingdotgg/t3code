import { assert, describe, it } from "@effect/vitest";

import {
  finalizeInstalledApplications,
  parseDesktopEntry,
  parseExecArguments,
  parseMacApplicationBundleName,
  parseWindowsShortcutName,
} from "./installedApplicationParsing.ts";

describe("parseExecArguments", () => {
  it("splits on whitespace and drops field codes", () => {
    assert.deepEqual(parseExecArguments("/usr/share/antigravity/antigravity %F"), [
      "/usr/share/antigravity/antigravity",
    ]);
  });

  it("keeps spaces inside quoted paths", () => {
    assert.deepEqual(parseExecArguments('"/opt/My App/bin/run" --flag %U'), [
      "/opt/My App/bin/run",
      "--flag",
    ]);
  });

  it("unwraps escaped quotes and backslashes inside quotes", () => {
    assert.deepEqual(parseExecArguments('"/opt/a\\"b" x'), ['/opt/a"b', "x"]);
  });

  it("drops every field code but keeps real arguments", () => {
    assert.deepEqual(parseExecArguments("app %f %u %d %n %i %c %k %v %m --real"), [
      "app",
      "--real",
    ]);
  });

  it("does not treat a percent-prefixed word as a field code", () => {
    assert.deepEqual(parseExecArguments("app %foo"), ["app", "%foo"]);
  });
});

describe("parseDesktopEntry", () => {
  const entry = (body: string) => `[Desktop Entry]\n${body}\n`;

  it("reads a typical application entry", () => {
    const parsed = parseDesktopEntry(
      entry("Name=Antigravity\nExec=/usr/share/antigravity/antigravity %F\nType=Application"),
    );
    assert.deepEqual(parsed, {
      name: "Antigravity",
      command: "/usr/share/antigravity/antigravity",
      args: [],
    });
  });

  it("keeps arguments that precede the project path", () => {
    const parsed = parseDesktopEntry(entry("Name=Kiro\nExec=kiro ide %F\nType=Application"));
    assert.deepEqual(parsed?.args, ["ide"]);
  });

  it("skips hidden and NoDisplay entries", () => {
    assert.isNull(parseDesktopEntry(entry("Name=A\nExec=a\nType=Application\nNoDisplay=true")));
    assert.isNull(parseDesktopEntry(entry("Name=A\nExec=a\nType=Application\nHidden=true")));
  });

  it("skips terminal programs, which open a console rather than the project", () => {
    assert.isNull(
      parseDesktopEntry(entry("Name=htop\nExec=htop\nType=Application\nTerminal=true")),
    );
  });

  it("skips non-application types", () => {
    assert.isNull(parseDesktopEntry(entry("Name=Docs\nExec=x\nType=Link")));
  });

  it("skips entries missing a name or exec", () => {
    assert.isNull(parseDesktopEntry(entry("Exec=a\nType=Application")));
    assert.isNull(parseDesktopEntry(entry("Name=A\nType=Application")));
  });

  it("ignores localized keys in favor of the plain one", () => {
    const parsed = parseDesktopEntry(
      entry("Name[de]=Editor DE\nName=Editor\nExec=editor\nType=Application"),
    );
    assert.equal(parsed?.name, "Editor");
  });

  it("ignores [Desktop Action] groups so a secondary action cannot win", () => {
    const parsed = parseDesktopEntry(
      "[Desktop Entry]\nName=Main\nExec=main\nType=Application\n\n[Desktop Action new]\nName=New Window\nExec=main --new\n",
    );
    assert.equal(parsed?.name, "Main");
    assert.equal(parsed?.command, "main");
  });

  it("ignores comments and blank lines", () => {
    const parsed = parseDesktopEntry("[Desktop Entry]\n# a comment\n\nName=A\nExec=a\n");
    assert.equal(parsed?.name, "A");
  });
});

describe("parseMacApplicationBundleName", () => {
  it("strips the bundle extension", () => {
    assert.equal(parseMacApplicationBundleName("Sublime Text.app"), "Sublime Text");
  });

  it("rejects non-bundle entries", () => {
    assert.isNull(parseMacApplicationBundleName("README.txt"));
  });
});

describe("parseWindowsShortcutName", () => {
  it("strips the shortcut extension", () => {
    assert.equal(parseWindowsShortcutName("Notepad++.lnk"), "Notepad++");
  });

  it("rejects uninstallers and help links", () => {
    assert.isNull(parseWindowsShortcutName("Uninstall Foo.lnk"));
    assert.isNull(parseWindowsShortcutName("Readme.lnk"));
  });

  it("rejects non-shortcut entries", () => {
    assert.isNull(parseWindowsShortcutName("app.exe"));
  });
});

describe("finalizeInstalledApplications", () => {
  it("assigns slug ids and sorts by name", () => {
    const result = finalizeInstalledApplications([
      { name: "Zed", command: "zed", args: [] },
      { name: "Antigravity", command: "agy", args: [] },
    ]);
    assert.deepEqual(
      result.map((app) => app.id),
      ["antigravity", "zed"],
    );
  });

  it("keeps the first of two entries sharing a name", () => {
    const result = finalizeInstalledApplications([
      { name: "Zed", command: "/usr/bin/zed", args: [] },
      { name: "Zed", command: "/home/me/.local/bin/zed", args: [] },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.command, "/usr/bin/zed");
  });

  it("drops entries whose name yields no usable slug", () => {
    assert.deepEqual(finalizeInstalledApplications([{ name: "***", command: "x", args: [] }]), []);
  });
});
