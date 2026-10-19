import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Terminal from "effect/Terminal";

import * as BootService from "../cloud/bootService.ts";
import {
  acquireRelayClientForLink,
  headlessSessionConfig,
  reportCloudDisconnectResults,
} from "./connect.ts";
import { recoverServiceOnboardingOffer } from "./service.ts";

const readHeadlessSessionConfig = (env: Record<string, string>) =>
  headlessSessionConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("detects headless operation from individual SSH config values", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* readHeadlessSessionConfig({}));
    assert.isFalse(yield* readHeadlessSessionConfig({ CI: "true" }));
    assert.isTrue(yield* readHeadlessSessionConfig({ SSH_CONNECTION: "client server" }));
    assert.isTrue(yield* readHeadlessSessionConfig({ SSH_TTY: "/dev/pts/1" }));
  }),
);

it.effect("treats cancelling optional background setup as a successful skip", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(Effect.fail(new Terminal.QuitError({})));
    assert.isFalse(result);
  }),
);

it.effect("keeps a successful connection when a remote service update is pending", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServiceUpdatePendingError()),
    );
    assert.isFalse(result);
  }),
);

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.effect("installs the relay client after the user accepts the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const progress: Array<string> = [];
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: (report) =>
          report({ type: "progress", stage: "downloading" }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                installCalls += 1;
                return managedExecutable;
              }),
            ),
          ),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(true),
      (event) =>
        Effect.sync(() => {
          if (event.type === "progress") {
            progress.push(event.stage);
          }
        }),
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(installCalls, 1);
    assert.deepEqual(progress, ["downloading"]);
  }),
);

it.effect("reuses an available relay client executable without prompting", () =>
  Effect.gen(function* () {
    let promptCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed(managedExecutable),
        install: Effect.die("unexpected install"),
        installWithProgress: () => Effect.die("unexpected install"),
        pruneManagedVersions: Effect.void,
      },
      () =>
        Effect.sync(() => {
          promptCalls += 1;
          return false;
        }),
      () => Effect.void,
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(promptCalls, 0);
  }),
);

it.effect("keeps disconnect causes in structured logs and out of console warnings", () => {
  const warnings: ReadonlyArray<unknown>[] = [];
  const logs: Readonly<Record<string, unknown>>[] = [];
  const testConsole = {
    ...globalThis.console,
    warn: (...args: ReadonlyArray<unknown>) => {
      warnings.push(args);
    },
  } satisfies Console.Console;
  const logger = Logger.make(({ fiber }) => {
    logs.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  const liveFailure = "live unlink private diagnostic";
  const relayFailure = "relay revoke private diagnostic";

  return reportCloudDisconnectResults({
    clearAuthorization: true,
    liveResult: {
      status: "failed",
      cause: Cause.fail(new Error(liveFailure)),
    },
    relayResult: Exit.failCause(Cause.die(new Error(relayFailure))),
  }).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.lengthOf(warnings, 2);
        const warningText = warnings.flat().map(String).join("\n");
        assert.include(warningText, "running server could not stop its tunnel");
        assert.include(warningText, "Could not revoke the relay-side environment record");
        assert.notInclude(warningText, liveFailure);
        assert.notInclude(warningText, relayFailure);
        assert.deepEqual(
          logs.map(({ operation, clearAuthorization }) => ({ operation, clearAuthorization })),
          [
            { operation: "live-server-unlink", clearAuthorization: true },
            { operation: "relay-environment-unlink", clearAuthorization: true },
          ],
        );
        const loggedCauses = logs.map((log) => String(log.cause)).join("\n");
        assert.include(loggedCauses, liveFailure);
        assert.include(loggedCauses, relayFailure);
      }),
    ),
  );
});

/** Captures console lines from a successful local disconnect report. */
const captureDisconnectReport = (input: {
  readonly clearAuthorization: boolean;
  readonly liveResult: {
    readonly status: "succeeded";
  };
  readonly relayResult: Exit.Exit<
    { readonly status: "not-authenticated" } | { readonly status: "revoked" },
    unknown
  >;
}) => {
  const lines: Array<{ readonly stream: "log" | "warn"; readonly text: string }> = [];
  const testConsole = {
    ...globalThis.console,
    log: (...args: ReadonlyArray<unknown>) => {
      lines.push({ stream: "log", text: args.map(String).join(" ") });
    },
    warn: (...args: ReadonlyArray<unknown>) => {
      lines.push({ stream: "warn", text: args.map(String).join(" ") });
    },
  } satisfies Console.Console;

  return reportCloudDisconnectResults(input).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(Logger.layer([Logger.make(() => undefined)], { mergeWithExisting: false })),
    Effect.as(lines),
  );
};

it.effect("warns to deregister when unlink has no stored CLI authorization", () =>
  Effect.gen(function* () {
    const lines = yield* captureDisconnectReport({
      clearAuthorization: false,
      liveResult: { status: "succeeded" },
      relayResult: Exit.succeed({ status: "not-authenticated" }),
    });

    assert.deepEqual(
      lines.map((line) => line.stream),
      ["log", "warn"],
    );
    assert.equal(lines[0]?.text, "T3 Connect is disabled locally.");
    assert.include(lines[1]?.text, "The relay-side environment record was not revoked.");
    assert.include(lines[1]?.text, "T3 Connect page of your T3 account");
    assert.include(lines[1]?.text, "`t3 connect login`");
    assert.notInclude(lines.map((line) => line.text).join("\n"), "Revoked the relay-side");
  }),
);

it.effect("points a failed relay unlink at retry and account deregistration", () =>
  Effect.gen(function* () {
    const lines = yield* captureDisconnectReport({
      clearAuthorization: false,
      liveResult: { status: "succeeded" },
      relayResult: Exit.fail("relay unreachable"),
    });
    const warning = lines.find((line) => line.stream === "warn")?.text ?? "";

    assert.equal(lines[0]?.text, "T3 Connect is disabled locally.");
    assert.include(warning, "Run `t3 connect unlink` again when the relay is reachable");
    assert.include(warning, "deregister it from the T3 Connect page of your T3 account");
    assert.notInclude(warning, "relay unreachable");
  }),
);
