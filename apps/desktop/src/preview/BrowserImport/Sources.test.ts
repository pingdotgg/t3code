// @effect-diagnostics nodeBuiltinImport:off - Drives the raw fs paths the module under test uses.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BROWSER_IMPORT_SOURCES, cookieDatabasePath, isSourceRunning } from "./Sources.ts";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;
const realHome = process.env.HOME;

// `userDataDirectory()` resolves `os.homedir()` on every call, and on POSIX
// that reads $HOME, so a scratch home is enough to exercise the real function.
const withScratchHome = async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-sources-"));
  process.env.HOME = home;
  await NodeFSP.mkdir(helium.userDataDirectory(), { recursive: true });
  return home;
};

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

describe("isSourceRunning", () => {
  it("reads Chromium's dangling SingletonLock symlink as a running browser", async () => {
    // Chromium points `SingletonLock` at `<host>-<pid>`, a target that never
    // exists on disk. A check that follows the link reports a running browser
    // as closed, which lets an import read a live, mid-write cookie database.
    await withScratchHome();
    expect(await isSourceRunning(helium)).toBe(false);

    await NodeFSP.symlink(
      "host-that-does-not-exist-1234",
      NodePath.join(helium.userDataDirectory(), "SingletonLock"),
    );

    expect(await isSourceRunning(helium)).toBe(true);
  });
});

describe("cookieDatabasePath", () => {
  it("places the cookie database under the source profile directory", async () => {
    const home = await withScratchHome();
    expect(cookieDatabasePath(helium, "Profile 1")).toBe(
      NodePath.join(home, "Library/Application Support/net.imput.helium/Profile 1/Cookies"),
    );
  });
});
