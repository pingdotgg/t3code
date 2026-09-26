import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The native compiler targets the actual host; this script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native compilation only runs on the actual Linux host.
const hostPlatform = process.platform;

describe.skipIf(hostPlatform !== "linux")("bundled libsecret helper", () => {
  let directory;
  let executable;
  beforeAll(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-browser-secret-test-"));
    executable = NodePath.join(directory, "t3-browser-secret");
    const root = NodeURL.fileURLToPath(new URL("../../../native/browser-secret/", import.meta.url));
    const flags = NodeChildProcess.execFileSync(
      "pkg-config",
      ["--cflags", "--libs", "libsecret-1"],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split(/\s+/);
    NodeChildProcess.execFileSync(
      process.env.CC || "cc",
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        NodePath.join(root, "main.c"),
        NodePath.join(root, "test.c"),
        "-Wl,--wrap=secret_service_search_sync",
        "-Wl,--wrap=secret_item_get_locked",
        "-Wl,--wrap=secret_item_get_secret",
        "-o",
        executable,
        ...flags,
      ],
      { stdio: "pipe" },
    );
  });
  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  const run = (args) =>
    NodeChildProcess.spawnSync(executable, args, {
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/unused-test-bus" },
    });

  it("builds an executable for the requested architecture into a staged resource directory", () => {
    const output = NodePath.join(directory, "resources", "browser-secret", "t3-browser-secret");
    NodeChildProcess.execFileSync(process.execPath, [
      NodeURL.fileURLToPath(new URL("./build-browser-secret.mjs", import.meta.url)),
      "--arch",
      hostArch,
      "--output",
      output,
    ]);
    const header = NodeFS.readFileSync(output).subarray(0, 20);
    expect(header.toString("hex", 0, 6)).toBe("7f454c460201");
    expect(header.readUInt16LE(18)).toBe({ x64: 62, arm64: 183 }[hostArch]);
    expect(NodeFS.statSync(output).mode & 0o111).not.toBe(0);
    // Invalid arguments exit before the real executable could contact a keyring.
    expect(NodeChildProcess.spawnSync(output, []).status).toBe(64);
  });

  it("preserves the exact secret bytes with no added or removed delimiter", () => {
    const result = run(["success"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(Buffer.from("secret\0with whitespace \t\r\n"));
    expect(result.stderr.length).toBe(0);
  });

  for (const [scenario, code] of [
    ["missing", 2],
    ["empty", 2],
    ["locked", 3],
    ["cancelled", 3],
    ["denied", 3],
    ["unavailable", 4],
    ["unloaded", 4],
  ]) {
    it(`reports ${scenario} without emitting a secret`, () => {
      const result = run([scenario]);
      expect(result.status).toBe(code);
      expect(result.stdout.length).toBe(0);
    });
  }
  it("rejects invalid arguments before accessing the keyring", () => {
    for (const args of [[], [""], ["chrome", "extra"]]) {
      const result = run(args);
      expect(result.status).toBe(64);
      expect(result.stdout.length).toBe(0);
    }
  });
});
