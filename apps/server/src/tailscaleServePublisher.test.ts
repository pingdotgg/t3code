import { assert, it } from "@effect/vitest";
import {
  TailscaleCommandExitError,
  TailscaleCommandTimeoutError,
  TailscaleServeHttpsDisabledError,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  describeTailscaleServeFailure,
  keepTailscaleServePublished,
} from "./tailscaleServePublisher.ts";

const route = { localPort: 3773, urlHost: "127.0.0.1", servePort: 443 };
const command = { executable: "tailscale", subcommand: "serve", argumentCount: 4 } as const;
const permissionDenied = new TailscaleCommandExitError({
  ...command,
  exitCode: 1,
  stderrLength: 197,
  stderrDiagnostic: "permission-denied",
});
const timedOut = new TailscaleCommandTimeoutError({ ...command, timeoutMs: 10_000, cause: null });

it("names a remedy for each way Tailscale Serve fails", () => {
  assert.include(
    describeTailscaleServeFailure(permissionDenied, route),
    "sudo tailscale set --operator=$USER",
  );
  // A tailnet without Serve or HTTPS makes a running Tailscale wait on its enable prompt.
  const timeout = describeTailscaleServeFailure(timedOut, route);
  assert.include(timeout, "10 seconds");
  assert.include(timeout, "HTTPS certificates are enabled");
  assert.include(timeout, "https://login.tailscale.com/admin/dns");
  assert.include(
    describeTailscaleServeFailure(new TailscaleServeHttpsDisabledError(), route),
    "https://login.tailscale.com/admin/dns",
  );
  assert.include(
    describeTailscaleServeFailure(
      new TailscaleCommandExitError({ ...command, exitCode: 1, stderrLength: 0 }),
      route,
    ),
    "tailscale serve --bg --https=443 http://127.0.0.1:3773",
  );
});

it.effect("retries Tailscale Serve until it is published, then leaves a removed route alone", () =>
  Effect.gen(function* () {
    const problem = yield* SubscriptionRef.make<string | undefined>(undefined);
    const holders = ["unreadable", "none", "none", "none", "dead"] as const;
    const attempts = [permissionDenied, undefined, undefined];
    let reads = 0;
    let ensures = 0;
    yield* keepTailscaleServePublished({
      route,
      readHolder: Effect.sync(() => holders[reads++] ?? "none"),
      ensure: Effect.suspend(() => {
        const failure = attempts[ensures++];
        return failure === undefined ? Effect.void : Effect.fail(failure);
      }),
      problem,
    }).pipe(Effect.forkScoped({ startImmediately: true }));

    // Tailscale was not ready at startup: nothing was attempted, and the reason is reported.
    assert.equal(ensures, 0);
    assert.include(yield* SubscriptionRef.get(problem), "could not be read");

    yield* TestClock.adjust("30 seconds");
    assert.equal(ensures, 1);
    assert.include(yield* SubscriptionRef.get(problem), "sudo tailscale set --operator=$USER");

    yield* TestClock.adjust("30 seconds");
    assert.equal(ensures, 2);
    assert.isUndefined(yield* SubscriptionRef.get(problem));

    // Published once, a route someone removed stays removed; one on a dead port is taken back.
    yield* TestClock.adjust("30 seconds");
    assert.equal(ensures, 2);
    yield* TestClock.adjust("30 seconds");
    assert.equal(ensures, 3);
  }),
);
