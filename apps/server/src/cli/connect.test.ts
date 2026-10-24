import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  acquireRelayClientForLink,
  formatCloudStatus,
  isLinkedAccountMismatch,
} from "./connect.ts";

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
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it("flags a mismatch only when both the linked and current cloud user ids are known and differ", () => {
  assert.isTrue(isLinkedAccountMismatch("user_old", "user_new"));
  assert.isFalse(isLinkedAccountMismatch("user_old", "user_old"));
  assert.isFalse(isLinkedAccountMismatch(null, "user_new"));
  assert.isFalse(isLinkedAccountMismatch("user_old", null));
});

it("explains an account mismatch in connect status output", () => {
  const status = {
    desired: true,
    authenticated: true,
    linked: true,
    revoked: false,
    cloudUserId: "user_old",
    currentCloudUserId: "user_new",
    accountMismatch: true,
    relayUrl: "https://relay.example.test",
    publishAgentActivity: false,
    relayClient: managedExecutable,
    linkMode: "managed" as const,
    reachability: null,
  };

  const human = formatCloudStatus(status);
  assert.include(human, "different account than the current sign-in");
  assert.include(human, "`t3 connect unlink`, then `t3 connect link`");
  assert.include(formatCloudStatus(status, { json: true }), '"accountMismatch": true');
  assert.notInclude(
    formatCloudStatus({ ...status, accountMismatch: false, currentCloudUserId: "user_old" }),
    "different account",
  );
});
