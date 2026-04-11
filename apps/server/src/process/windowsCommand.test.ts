import { assert, it } from "@effect/vitest";

import {
  isWindowsBatchShim,
  isWindowsCommandNotFound,
  makeWindowsCmdCommandLine,
  makeWindowsCmdSpawnArguments,
  quoteForWindowsCmd,
  resolveWindowsCommandShell,
} from "./windowsCommand";

it("resolves cmd.exe from Windows command shell environment variables", () => {
  assert.equal(resolveWindowsCommandShell({}), "cmd.exe");
  assert.equal(
    resolveWindowsCommandShell({ COMSPEC: "C:\\Windows\\System32\\cmd.exe" }),
    "C:\\Windows\\System32\\cmd.exe",
  );
  assert.equal(
    resolveWindowsCommandShell({ ComSpec: "C:\\custom\\cmd.exe" }),
    "C:\\custom\\cmd.exe",
  );
});

it("detects Windows batch shims case-insensitively", () => {
  assert.equal(isWindowsBatchShim("code.cmd"), true);
  assert.equal(isWindowsBatchShim("C:\\tools\\launcher.BAT"), true);
  assert.equal(isWindowsBatchShim("/tmp/code.exe"), false);
});

it("detects Windows command-not-found exits", () => {
  assert.equal(isWindowsCommandNotFound(9009, "", "win32"), true);
  assert.equal(
    isWindowsCommandNotFound(
      1,
      "'foo' is not recognized as an internal or external command",
      "win32",
    ),
    true,
  );
  assert.equal(isWindowsCommandNotFound(9009, "", "darwin"), false);
});

it("quotes Windows cmd values safely", () => {
  assert.equal(
    quoteForWindowsCmd('C:\\work\\100% real\\"quoted".ts:12:4'),
    '"C:\\work\\100%% real\\""quoted"".ts:12:4"',
  );
});

it("builds Windows cmd command lines safely", () => {
  assert.equal(
    makeWindowsCmdCommandLine("code.cmd", ["--goto", "file.ts:12:4"]),
    '""code.cmd" "--goto" "file.ts:12:4""',
  );
});

it("builds Windows cmd spawn arguments with cmd control flags", () => {
  assert.deepEqual(makeWindowsCmdSpawnArguments("code.cmd", ["--goto", "file.ts:1:1"]), [
    "/d",
    "/v:off",
    "/s",
    "/c",
    '""code.cmd" "--goto" "file.ts:1:1""',
  ]);
});
