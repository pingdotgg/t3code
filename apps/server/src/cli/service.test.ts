import { assert, it } from "@effect/vitest";

import { formatServiceStatus, serviceDowngradeRefusal } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
  installedVersion: "0.0.29",
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

it("explains service availability without systemd", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd",
  );
});

it("reports a newer installed service without recommending latest", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.32-nightly.1" },
    "0.0.31",
  );

  assert.include(output, "t3@0.0.32-nightly.1 (newer than this t3@0.0.31 CLI)");
  assert.include(output, "npx t3@0.0.32-nightly.1 service update");
  assert.notInclude(output, "npx t3@latest service update");
});

it("refuses service downgrades unless explicitly allowed", () => {
  const refusal = serviceDowngradeRefusal({
    installedVersion: "0.0.32-nightly.1",
    targetVersion: "0.0.31",
    allowDowngrade: false,
  });
  assert.instanceOf(refusal, Error);
  assert.deepInclude(refusal, {
    _tag: "ServiceDowngradeRefusedError",
    installedVersion: "0.0.32-nightly.1",
    targetVersion: "0.0.31",
  });
  assert.isNull(
    serviceDowngradeRefusal({
      installedVersion: "0.0.32-nightly.1",
      targetVersion: "0.0.31",
      allowDowngrade: true,
    }),
  );
  assert.isNull(
    serviceDowngradeRefusal({
      installedVersion: undefined,
      targetVersion: "0.0.31",
      allowDowngrade: false,
    }),
  );
});
