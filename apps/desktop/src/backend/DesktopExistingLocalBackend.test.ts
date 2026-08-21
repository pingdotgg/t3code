import { assert, describe, it } from "@effect/vitest";

import { collectSeedBaseDirs, parseSystemdT3Home } from "./DesktopExistingLocalBackend.ts";

describe("parseSystemdT3Home", () => {
  it("reads a simple Environment assignment", () => {
    assert.equal(
      parseSystemdT3Home("Environment=T3CODE_HOME=/home/pedro/.t3/codebox2\n"),
      "/home/pedro/.t3/codebox2",
    );
  });

  it("reads quoted Environment assignments and drop-in overlays", () => {
    assert.equal(parseSystemdT3Home('Environment="T3CODE_HOME=/data/t3 home"\n'), "/data/t3 home");
    assert.equal(
      parseSystemdT3Home("Environment=T3CODE_HOST=0.0.0.0 T3CODE_HOME=/opt/t3 T3CODE_PORT=4100\n"),
      "/opt/t3",
    );
  });

  it("returns null when T3CODE_HOME is absent", () => {
    assert.equal(parseSystemdT3Home("Environment=T3CODE_PORT=4100\n"), null);
    assert.equal(parseSystemdT3Home(""), null);
  });
});

describe("collectSeedBaseDirs", () => {
  it("prefers the desktop home, then ~/.t3, then the systemd home", () => {
    assert.deepEqual(
      collectSeedBaseDirs({
        homeDirectory: "/home/pedro",
        desktopBaseDir: "/home/pedro/.t3/desktop",
        systemdT3Home: "/home/pedro/.t3/codebox2",
      }),
      ["/home/pedro/.t3/desktop", "/home/pedro/.t3", "/home/pedro/.t3/codebox2"],
    );
  });

  it("deduplicates identical paths", () => {
    assert.deepEqual(
      collectSeedBaseDirs({
        homeDirectory: "/home/pedro",
        desktopBaseDir: "/home/pedro/.t3",
        systemdT3Home: "/home/pedro/.t3",
      }),
      ["/home/pedro/.t3"],
    );
  });
});
