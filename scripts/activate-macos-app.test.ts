import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const APP_PATH = "/Applications/T3 Code (Dev).app";
const BUNDLE_ID = "com.t3tools.t3code.dev";

/**
 * Runs the helper with fake `open`/`osascript` commands. `osascript` rejects
 * the first `failures` calls the way a freshly launched app does (-609) and
 * accepts every call after that.
 */
function runActivation(failures: number) {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-app-activation-"));
  const bin = Path.join(root, "bin");
  const log = Path.join(root, "calls.log");
  FS.mkdirSync(bin);
  FS.writeFileSync(
    Path.join(bin, "open"),
    `#!/bin/sh\nprintf 'open %s\\n' "$*" >> "$ACTIVATION_TEST_LOG"\n`,
    { mode: 0o755 },
  );
  FS.writeFileSync(
    Path.join(bin, "osascript"),
    [
      "#!/bin/sh",
      `printf 'osascript %s\\n' "$*" >> "$ACTIVATION_TEST_LOG"`,
      `calls=$(grep -c '^osascript' "$ACTIVATION_TEST_LOG")`,
      `if [ "$calls" -le ${failures} ]; then echo "execution error: Connection is invalid. (-609)" >&2; exit 1; fi`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(
      "/bin/bash",
      [Path.join(import.meta.dirname, "activate-macos-app.sh"), APP_PATH, BUNDLE_ID],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          ACTIVATION_TEST_LOG: log,
          T3CODE_ACTIVATION_RETRY_INTERVAL: "0",
        },
      },
    );
    return { result, calls: FS.readFileSync(log, "utf8").trimEnd().split("\n") };
  } finally {
    FS.rmSync(root, { recursive: true, force: true });
  }
}

const ACTIVATE_CALL = `osascript -e tell application id "${BUNDLE_ID}" to activate`;

describe("macOS app activation", () => {
  it("launches the installed bundle and activates it by bundle ID", () => {
    const { result, calls } = runActivation(0);

    expect(result.status).toBe(0);
    expect(calls).toEqual([`open -a ${APP_PATH}`, ACTIVATE_CALL]);
  });

  it("retries while the freshly launched app is not yet accepting Apple events", () => {
    const { result, calls } = runActivation(3);

    expect(result.status).toBe(0);
    expect(calls).toEqual([
      `open -a ${APP_PATH}`,
      ACTIVATE_CALL,
      ACTIVATE_CALL,
      ACTIVATE_CALL,
      ACTIVATE_CALL,
    ]);
  });

  it("does not fail the install when activation never succeeds", () => {
    const { result, calls } = runActivation(Number.MAX_SAFE_INTEGER);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Could not bring");
    expect(calls.filter((call) => call.startsWith("osascript"))).toHaveLength(50);
  });
});
