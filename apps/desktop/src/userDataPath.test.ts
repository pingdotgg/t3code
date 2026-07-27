import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDesktopBaseDirectory, resolveUserDataPath } from "./userDataPath.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeAppDataDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-user-data-path-test-"));
  tempDirectories.push(directory);
  return directory;
}

describe("resolveUserDataPath", () => {
  it("keeps using the canonical profile when both canonical and legacy profiles exist", () => {
    const appDataDirectory = makeAppDataDirectory();
    const canonicalPath = path.join(appDataDirectory, "t3code-dev");
    const legacyPath = path.join(appDataDirectory, "T3 Code (Dev)");
    fs.mkdirSync(canonicalPath);
    fs.mkdirSync(legacyPath);

    expect(
      resolveUserDataPath({
        appDataDirectory,
        canonicalDirectoryName: "t3code-dev",
        legacyDirectoryName: "T3 Code (Dev)",
      }),
    ).toBe(canonicalPath);
  });

  it("uses the legacy profile when it is the only existing profile", () => {
    const appDataDirectory = makeAppDataDirectory();
    const legacyPath = path.join(appDataDirectory, "T3 Code (Dev)");
    fs.mkdirSync(legacyPath);

    expect(
      resolveUserDataPath({
        appDataDirectory,
        canonicalDirectoryName: "t3code-dev",
        legacyDirectoryName: "T3 Code (Dev)",
      }),
    ).toBe(legacyPath);
  });

  it("uses the canonical path for a new profile", () => {
    const appDataDirectory = makeAppDataDirectory();

    expect(
      resolveUserDataPath({
        appDataDirectory,
        canonicalDirectoryName: "t3code-dev",
        legacyDirectoryName: "T3 Code (Dev)",
      }),
    ).toBe(path.join(appDataDirectory, "t3code-dev"));
  });
});

describe("resolveDesktopBaseDirectory", () => {
  it("isolates Dev and Alpha server state by default", () => {
    const homeDirectory = path.join(path.sep, "Users", "test");

    expect(
      resolveDesktopBaseDirectory({
        configuredHome: undefined,
        homeDirectory,
        isDevAppFlavor: true,
      }),
    ).toBe(path.join(homeDirectory, ".t3-dev"));
    expect(
      resolveDesktopBaseDirectory({
        configuredHome: undefined,
        homeDirectory,
        isDevAppFlavor: false,
      }),
    ).toBe(path.join(homeDirectory, ".t3-alpha"));
  });
});
