import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";

import {
  acquireRelayClientForLink,
  authorizeCliWith,
  cloudConfigurationError,
  formatHeadlessAuthorizationPrompt,
  isHeadlessConnectEnvironment,
  reportCloudDisconnectResults,
} from "./connect.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";

it("permits credential-only login without a relay URL", () => {
  const oauthOnly = {
    hasCliOAuthConfig: true,
    hasPublicConfig: false,
  };

  assert.isUndefined(cloudConfigurationError("oauth", oauthOnly));
  assert.equal(
    cloudConfigurationError("full", oauthOnly),
    "T3 Connect is not configured. Set T3CODE_RELAY_URL, T3CODE_CLERK_PUBLISHABLE_KEY, and T3CODE_CLERK_CLI_OAUTH_CLIENT_ID.",
  );
});

it("selects out-of-band authorization for SSH sessions and formats its prompt", () => {
  assert.isTrue(isHeadlessConnectEnvironment({ SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 2" }));
  assert.isTrue(isHeadlessConnectEnvironment({ SSH_TTY: "/dev/pts/1" }));
  assert.isFalse(isHeadlessConnectEnvironment({}));
  assert.equal(
    formatHeadlessAuthorizationPrompt("https://app.example.test/connect#state=abc"),
    [
      "Headless authorization",
      "Open this URL on a device with a browser:",
      "  https://app.example.test/connect#state=abc",
      "",
      "After signing in, return here and enter the code shown in your browser.",
    ].join("\n"),
  );
});

const token = (identity: string): CliTokenManager.PersistedToken => ({
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAtEpochMs: Date.now() + 60_000,
  identity,
});

it.effect("reuses a stored headless credential without starting authorization", () =>
  Effect.gen(function* () {
    let loginCalls = 0;
    const identity = yield* authorizeCliWith(
      { headless: true },
      {
        get: Effect.die("unexpected browser login"),
        getExisting: Effect.succeed(Option.some(token("stored@example.test"))),
        hasCredential: Effect.succeed(true),
        store: () => Effect.die("unexpected token store"),
        clear: Effect.void,
      },
      Effect.sync(() => {
        loginCalls += 1;
        return { token: token("new@example.test"), identity: "new@example.test" };
      }),
    );

    assert.equal(identity, "stored@example.test");
    assert.equal(loginCalls, 0);
  }),
);

it.effect("falls back to headless authorization after refresh failure and stores the token", () =>
  Effect.gen(function* () {
    const stored: CliTokenManager.PersistedToken[] = [];
    const replacement = token("replacement@example.test");
    const identity = yield* authorizeCliWith(
      { headless: true },
      {
        get: Effect.die("unexpected browser login"),
        getExisting: Effect.fail(
          new CliTokenManager.CloudCliCredentialRefreshError({ cause: "revoked" }),
        ),
        hasCredential: Effect.succeed(true),
        store: (value) =>
          Effect.sync(() => {
            stored.push(value);
          }),
        clear: Effect.void,
      },
      Effect.succeed({ token: replacement, identity: "replacement@example.test" }),
    );

    assert.equal(identity, "replacement@example.test");
    assert.deepEqual(stored, [replacement]);
  }),
);

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

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
