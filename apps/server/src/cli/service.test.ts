import { assert, it } from "@effect/vitest";

import { formatServicePruneResult, formatServiceStatus } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "T3 Code service",
      "  Status: installed · t3@0.0.29",
      "  Unit: /home/me/.config/systemd/user/t3code.service",
      "  Logs: /home/me/.t3/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx t3@latest service update`.",
  );
});

it("explains where the service is supported", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, macOS with launchd",
  );
});

it("formats a service runtime prune preview", () => {
  assert.equal(
    formatServicePruneResult({ dryRun: true, versions: ["0.0.31", "0.0.32"] }),
    ["Would prune 2 old T3 Code service runtimes:", "  t3@0.0.31", "  t3@0.0.32"].join("\n"),
  );
});

it("formats a completed service runtime prune", () => {
  assert.equal(
    formatServicePruneResult({ dryRun: false, versions: ["0.0.31"] }),
    ["Pruned 1 old T3 Code service runtime:", "  t3@0.0.31"].join("\n"),
  );
});

it("reports when there are no old service runtimes", () => {
  assert.equal(
    formatServicePruneResult({ dryRun: false, versions: [] }),
    "No old T3 Code service runtimes found.",
  );
});
