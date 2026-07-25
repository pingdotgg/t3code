import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { formatServiceStatus, parseServiceEnvironmentEntries, serviceCommand } from "./service.ts";

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

it("preserves an explicit service host and port in the repair command", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29", {
      supervisor: "s6",
      s6ServiceDir: "/run/service/t3code",
      serverHost: "0.0.0.0",
      serverPort: 3773,
    }),
    "Next: Run `npx t3@latest service update --supervisor s6 --service-dir '/run/service/t3code' --host '0.0.0.0' --port 3773`.",
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

it("parses repeated service environment entries without splitting value equals", () => {
  assert.deepEqual(
    parseServiceEnvironmentEntries(
      ["SECOND=two", "FIRST=spaces ' $dollar `backtick` and=equals"],
      "s6",
    ),
    [
      { name: "FIRST", value: "spaces ' $dollar `backtick` and=equals" },
      { name: "SECOND", value: "two" },
    ],
  );
});

it("rejects invalid, reserved, duplicate, and unsafe service environment entries", () => {
  const invalidEntries = [
    ["MISSING_EQUALS"],
    ["9INVALID=value"],
    ["T3CODE_HOME=value"],
    ["DUPLICATE=first", "DUPLICATE=second"],
    ["UNSAFE=line\rbreak"],
    ["UNSAFE=line\nbreak"],
    ["UNSAFE=nul\0break"],
  ];

  for (const entries of invalidEntries) {
    assert.throws(() => parseServiceEnvironmentEntries(entries, "s6"));
  }
});

it("rejects service environment entries for systemd without leaking their values", () => {
  const secret = "do-not-print-$SECRET=`command`";
  let error: unknown;
  try {
    parseServiceEnvironmentEntries([`EXAMPLE=${secret}`], "systemd");
  } catch (cause) {
    error = cause;
  }

  assert.instanceOf(error, Error);
  assert.include((error as Error).message, "--supervisor s6");
  assert.notInclude((error as Error).message, secret);
});

it.effect("rejects the option on install and update without CLI error leakage", () =>
  Effect.gen(function* () {
    const secret = "do-not-print-$SECRET=`command`";
    const run = Command.runWith(serviceCommand, { version: "test" });

    for (const action of ["install", "update"]) {
      const error = yield* run([action, "--service-environment", `EXAMPLE=${secret}`]).pipe(
        Effect.flip,
      );
      assert.instanceOf(error, Error);
      assert.include(error.message, "--supervisor s6");
      assert.notInclude(error.message, secret);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("does not include service environment values in stale status output", () => {
  const secret = "do-not-print-$SECRET=`command`";
  const options = {
    supervisor: "s6" as const,
    s6ServiceDir: "/run/service/t3code",
    serviceEnvironment: [{ name: "EXAMPLE", value: secret }],
  };

  const output = formatServiceStatus({ ...status, current: false }, "0.0.29", options);
  assert.notInclude(output, secret);
  assert.notInclude(output, "--service-environment");
});
