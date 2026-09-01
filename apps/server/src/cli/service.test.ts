import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as BootService from "../cloud/bootService.ts";
import { formatServiceStatus, reconcileService } from "./service.ts";

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

it.effect("restarts an already-current service during reconciliation", () =>
  Effect.gen(function* () {
    let installCount = 0;
    const plan = {
      nodePath: "/usr/bin/node",
      launcherPath: "/home/me/.t3/runtime/service-launcher.mjs",
      baseDir: "/home/me/.t3",
      logPath: status.logPath,
      unitPath: status.unitPath,
    };
    const service = BootService.BootService.of({
      status: Effect.succeed(status),
      install: Effect.sync(() => {
        installCount += 1;
        return plan;
      }),
      uninstall: Effect.succeed(false),
    });

    const result = yield* reconcileService().pipe(
      Effect.provideService(BootService.BootService, service),
    );

    assert.equal(installCount, 1);
    assert.deepEqual(result, {
      changed: true,
      previouslyInstalled: true,
      previouslyCurrent: true,
      plan,
    });
  }),
);
