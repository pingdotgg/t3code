import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("macOS app activation", () => {
  it("launches the installed bundle and explicitly activates it", () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-app-activation-"));
    const bin = Path.join(root, "bin");
    const log = Path.join(root, "calls.log");
    FS.mkdirSync(bin);
    for (const command of ["open", "osascript"]) {
      const executable = Path.join(bin, command);
      FS.writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> "$ACTIVATION_TEST_LOG"\n`,
        { mode: 0o755 },
      );
    }

    try {
      execFileSync(
        "/bin/bash",
        [
          Path.join(import.meta.dirname, "activate-macos-app.sh"),
          "/Applications/T3 Code (Dev).app",
          "T3 Code (Dev)",
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            ACTIVATION_TEST_LOG: log,
          },
        },
      );

      expect(FS.readFileSync(log, "utf8")).toBe(
        'open -a /Applications/T3 Code (Dev).app\nosascript -e tell application "T3 Code (Dev)" to activate\n',
      );
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
});
