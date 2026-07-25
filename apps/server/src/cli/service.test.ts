import { assert, it } from "@effect/vitest";

import { formatServiceStatus } from "./service.ts";

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
      "  Definition: /home/me/.config/systemd/user/t3code.service",
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

it("preserves s6 selection in the repair command", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29", {
      supervisor: "s6",
      s6ServiceDir: "/run/service/T3 Code",
    }),
    "Next: Run `npx t3@latest service update --supervisor s6 --service-dir '/run/service/T3 Code'`.",
  );
});

it("preserves an explicit s6 service identity in the repair command", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29", {
      supervisor: "s6",
      s6ServiceDir: "/run/service/t3code",
      serviceUser: "t3 service",
      serviceGroup: "t3",
    }),
    "--service-user 't3 service' --service-group 't3'",
  );
});

it("explains service availability without a configured supervisor", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, or s6 with --service-dir",
  );
});
