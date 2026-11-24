// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { RESTORE_OOMD_WATCH_SCRIPT } from "./userManagerOom.ts";

const userService = "/user.slice/user-1001.slice/user@1001.service";

it.each([
  [
    "mirrors the system manager's kill policy onto the user manager's root slice",
    { cgroup: userService, mode: "kill", limit: "4252017622", duration: "" },
    "--user set-property --runtime -- -.slice ManagedOOMMemoryPressure=kill ManagedOOMMemoryPressureLimit=99.00%",
  ],
  [
    "keeps a custom duration and an unset limit",
    { cgroup: userService, mode: "kill", limit: "0", duration: "20s" },
    "--user set-property --runtime -- -.slice ManagedOOMMemoryPressure=kill ManagedOOMMemoryPressureLimit=0.00% ManagedOOMMemoryPressureDurationSec=20s",
  ],
  [
    "leaves the slice alone when oomd is not told to kill",
    { cgroup: userService, mode: "auto", limit: "0", duration: "infinity" },
    undefined,
  ],
  [
    "leaves the slice alone outside a user@ service",
    { cgroup: "/system.slice/foo.service", mode: "kill", limit: "0", duration: "infinity" },
    undefined,
  ],
])("%s", (_name, system, expected) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-oomd-"));
  try {
    const calls = NodePath.join(root, "calls");
    NodeFS.writeFileSync(
      NodePath.join(root, "systemctl"),
      [
        "#!/bin/sh",
        'echo "$*" >>"$CALLS"',
        'case "$*" in',
        '  *ControlGroup*) echo "$CGROUP" ;;',
        '  *ManagedOOMMemoryPressureLimit*) echo "$LIMIT" ;;',
        '  *ManagedOOMMemoryPressureDurationUSec*) echo "$DURATION" ;;',
        '  *ManagedOOMMemoryPressure\\ *) echo "$MODE" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", RESTORE_OOMD_WATCH_SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: `${root}:/usr/bin:/bin`,
        CALLS: calls,
        CGROUP: system.cgroup,
        MODE: system.mode,
        LIMIT: system.limit,
        DURATION: system.duration,
      },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const setProperty = NodeFS.readFileSync(calls, "utf8")
      .split("\n")
      .find((call) => call.includes("set-property"));
    expect(setProperty).toBe(expected);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
