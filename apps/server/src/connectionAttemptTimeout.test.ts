// @effect-diagnostics nodeBuiltinImport:off -- Fresh Node processes exercise runtime flags and timeout isolation.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

describe("CLI connection attempt timeout", () => {
  it.each([
    { name: "default", flags: [], nodeOptions: "", before: 250, after: 1_000, child: 250 },
    {
      name: "shorter CLI flag",
      flags: ["--network-family-autoselection-attempt-timeout=50"],
      nodeOptions: "",
      before: 50,
      after: 1_000,
      child: 250,
    },
    {
      name: "larger CLI flag",
      flags: ["--network-family-autoselection-attempt-timeout=5000"],
      nodeOptions: "",
      before: 5_000,
      after: 5_000,
      child: 250,
    },
    {
      name: "larger NODE_OPTIONS value",
      flags: [],
      nodeOptions: "--network-family-autoselection-attempt-timeout=5000",
      before: 5_000,
      after: 5_000,
      child: 5_000,
    },
  ])("enforces the floor without leaking it to children: $name", async (testCase) => {
    const { stdout } = await execFile(
      process.execPath,
      [
        ...testCase.flags,
        "--input-type=module",
        "--eval",
        `
          import { getDefaultAutoSelectFamilyAttemptTimeout as getTimeout } from "node:net";
          import { execFileSync } from "node:child_process";
          const { configureConnectionAttemptTimeout } = await import(${JSON.stringify(new URL("./connectionAttemptTimeout.ts", import.meta.url).href)});
          const before = getTimeout();
          configureConnectionAttemptTimeout();
          const after = getTimeout();
          const child = Number(execFileSync(process.execPath, [
            "--eval", "console.log(require('node:net').getDefaultAutoSelectFamilyAttemptTimeout())"
          ], { encoding: "utf8" }));
          console.log("TIMEOUTS=" + JSON.stringify({ before, after, child }));
        `,
      ],
      { env: { ...process.env, NODE_OPTIONS: testCase.nodeOptions }, timeout: 30_000 },
    );

    expect(stdout.split("\n").find((line) => line.startsWith("TIMEOUTS="))).toBe(
      `TIMEOUTS=${JSON.stringify({ before: testCase.before, after: testCase.after, child: testCase.child })}`,
    );
  });
});
