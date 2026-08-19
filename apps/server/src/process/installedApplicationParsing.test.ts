import { assert, describe, it } from "@effect/vitest";

import {
  applicationIdForName,
  finalizeInstalledApplications,
  isRememberableApplication,
  parseDesktopEntry,
  parseExecArguments,
  parseMacApplicationBundleName,
  parseWindowsShortcutName,
  PROJECT_PATH_PLACEHOLDER,
  substituteProjectPath,
  toCustomEditor,
} from "./installedApplicationParsing.ts";

describe("parseExecArguments", () => {
  it("splits on whitespace and marks where the project path goes", () => {
    assert.deepEqual(parseExecArguments("/usr/share/antigravity/antigravity %F"), [
      "/usr/share/antigravity/antigravity",
      PROJECT_PATH_PLACEHOLDER,
    ]);
  });

  it("keeps spaces inside quoted paths", () => {
    assert.deepEqual(parseExecArguments('"/opt/My App/bin/run" --flag %U'), [
      "/opt/My App/bin/run",
      "--flag",
      PROJECT_PATH_PLACEHOLDER,
    ]);
  });

  it("unwraps escaped quotes and backslashes inside quotes", () => {
    assert.deepEqual(parseExecArguments('"/opt/a\\"b" x'), ['/opt/a"b', "x"]);
  });

  it("drops non-path field codes and collapses repeated path codes to one", () => {
    assert.deepEqual(parseExecArguments("app %f %u %d %n %i %c %k %v %m --real"), [
      "app",
      PROJECT_PATH_PLACEHOLDER,
      "--real",
    ]);
  });

  // Regression: dropping the code and appending the path would launch
  // `editor --new-window <path>`, reordering the application's own arguments.
  it("keeps the placeholder where the entry put it, not at the end", () => {
    assert.deepEqual(parseExecArguments("editor %F --new-window"), [
      "editor",
      PROJECT_PATH_PLACEHOLDER,
      "--new-window",
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
      args: [PROJECT_PATH_PLACEHOLDER],
    });
  });

  it("keeps arguments that precede the project path", () => {
    const parsed = parseDesktopEntry(entry("Name=Kiro\nExec=kiro ide %F\nType=Application"));
    assert.deepEqual(parsed?.args, ["ide", PROJECT_PATH_PLACEHOLDER]);
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
  it("sorts by display name and gives each entry a readable id prefix", () => {
    const result = finalizeInstalledApplications([
      { name: "Zed", command: "zed", args: [] },
      { name: "Antigravity", command: "agy", args: [] },
    ]);
    assert.deepEqual(
      result.map((app) => app.name),
      ["Antigravity", "Zed"],
    );
    assert.isTrue(result[0]!.id.startsWith("antigravity-"));
    assert.isTrue(result[1]!.id.startsWith("zed-"));
  });

  // Scan order encodes directory precedence, so a user's own override wins.
  it("collapses two entries that share an exact name, keeping the first scanned", () => {
    const result = finalizeInstalledApplications([
      { name: "Zed", command: "/usr/bin/zed", args: [] },
      { name: "Zed", command: "/home/me/.local/bin/zed", args: [] },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.command, "/usr/bin/zed");
  });

  // Distinct applications whose readable prefixes match must both survive.
  it("keeps two applications whose names share a slug", () => {
    const result = finalizeInstalledApplications([
      { name: "Code - OSS", command: "/usr/bin/code-oss", args: [] },
      { name: "Code OSS", command: "/usr/bin/code", args: [] },
    ]);
    assert.equal(result.length, 2);
    assert.equal(new Set(result.map((app) => app.id)).size, 2);
  });

  it("assigns the same ids regardless of input order", () => {
    const a = { name: "Code - OSS", command: "/usr/bin/code-oss", args: [] };
    const b = { name: "Code OSS", command: "/usr/bin/code", args: [] };
    assert.deepEqual(
      finalizeInstalledApplications([a, b]).map((app) => `${app.id}:${app.command}`),
      finalizeInstalledApplications([b, a]).map((app) => `${app.id}:${app.command}`),
    );
  });

  // Regression: ids are persisted when a user remembers an application, so
  // installing another similarly-named program must not renumber an existing
  // entry onto a different binary.
  it("keeps an application's id fixed when a colliding name appears later", () => {
    const alone = finalizeInstalledApplications([
      { name: "Code OSS", command: "/usr/bin/code", args: [] },
    ]);
    const crowded = finalizeInstalledApplications([
      { name: "Code - OSS", command: "/usr/bin/code-oss", args: [] },
      { name: "Code OSS", command: "/usr/bin/code", args: [] },
    ]);
    const before = alone[0]?.id;
    const after = crowded.find((app) => app.command === "/usr/bin/code")?.id;
    assert.equal(after, before);
  });

  it("keeps applications whose names are entirely non-latin", () => {
    const result = finalizeInstalledApplications([
      { name: "日本語アプリ", command: "/usr/bin/nihongo", args: [] },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, "日本語アプリ");
  });

  it("still assigns an id to a name with no usable slug", () => {
    const result = finalizeInstalledApplications([{ name: "***", command: "x", args: [] }]);
    assert.equal(result.length, 1);
    assert.isTrue(result[0]!.id.length > 0);
  });
});

describe("substituteProjectPath", () => {
  it("replaces the placeholder in place", () => {
    assert.deepEqual(
      substituteProjectPath(["--new-window", PROJECT_PATH_PLACEHOLDER, "--wait"], "/repo"),
      ["--new-window", "/repo", "--wait"],
    );
  });

  it("appends when the entry named no placeholder", () => {
    assert.deepEqual(substituteProjectPath(["-a", "/Applications/Zed.app"], "/repo"), [
      "-a",
      "/Applications/Zed.app",
      "/repo",
    ]);
  });
});

describe("isRememberableApplication", () => {
  it("rejects a command longer than the settings schema allows", () => {
    assert.isFalse(
      isRememberableApplication({
        id: "long",
        name: "Long",
        command: "x".repeat(1025),
        args: [],
      }),
    );
  });

  it("rejects a name that truncates to nothing usable", () => {
    assert.isFalse(
      isRememberableApplication({
        id: "spaces",
        name: `${" ".repeat(70)}x`,
        command: "x",
        args: [],
      }),
    );
  });

  // `Exec=app "" %F` yields an empty argument that the CustomEditor schema
  // rejects, which would surface as a defect when the user picks it.
  it("rejects an application carrying an empty argument", () => {
    assert.isFalse(
      isRememberableApplication({
        id: "app",
        name: "App",
        command: "/usr/bin/app",
        args: ["", PROJECT_PATH_PLACEHOLDER],
      }),
    );
  });

  it("accepts an ordinary application", () => {
    assert.isTrue(
      isRememberableApplication({ id: "zed", name: "Zed", command: "/usr/bin/zed", args: [] }),
    );
  });
});

describe("toCustomEditor", () => {
  it("trims a label truncated onto whitespace so it passes schema validation", () => {
    const name = `${"a".repeat(63)} trailing`;
    const entry = toCustomEditor({ id: "a", name, command: "/usr/bin/a", args: [] });
    assert.equal(entry.label, "a".repeat(63));
    assert.equal(entry.label, entry.label.trim());
  });

  it("derives the custom id from the discovered id", () => {
    const entry = toCustomEditor({ id: "zed", name: "Zed", command: "/usr/bin/zed", args: [] });
    assert.equal(entry.id, "custom:zed");
  });
});

describe("applicationIdForName", () => {
  // The id lands in `CustomEditorId`, whose schema accepts only [0-9a-z-].
  const CUSTOM_EDITOR_ID = /^custom:[0-9a-z]([0-9a-z-]*[0-9a-z])?$/;

  it("produces an id the CustomEditorId schema accepts", () => {
    for (const name of ["Zed", "Code - OSS", "日本語アプリ", "café", "***", "1Password"]) {
      assert.match(`custom:${applicationIdForName(name)}`, CUSTOM_EDITOR_ID, name);
    }
  });

  it("keeps a readable prefix when the name is latin", () => {
    assert.isTrue(applicationIdForName("Android Studio").startsWith("android-studio-"));
  });

  it("is stable for the same name", () => {
    assert.equal(applicationIdForName("Zed"), applicationIdForName("Zed"));
  });

  it("separates names that share a slug", () => {
    assert.notEqual(applicationIdForName("Code - OSS"), applicationIdForName("Code OSS"));
  });
});
