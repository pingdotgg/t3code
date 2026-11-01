import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import {
  acquireRelayClientForLink,
  connectCommand,
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

it.effect("prints status even when the stored credential cannot be read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${baseDir}/userdata/secrets/cloud-cli-oauth-token.bin`, {
      recursive: true,
    });
    yield* Command.runWith(connectCommand, { version: "0.0.0" })([
      "status",
      "--json",
      "--base-dir",
      baseDir,
    ]);
    const status = JSON.parse(String((yield* TestConsole.logLines).at(-1)));
    assert.isFalse(status.authenticated);
    assert.isNull(status.currentCloudUserId);
    assert.isFalse(status.accountMismatch);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer))),
);

it.effect.each([
  { subject: "user_new", mismatch: true },
  { subject: "user_old", mismatch: false },
  { subject: undefined, mismatch: false },
])(
  "reports the linked account for credential subject $subject without replacing it",
  ({ subject, mismatch }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const secretsDir = `${baseDir}/userdata/secrets`;
      yield* fs.makeDirectory(secretsDir, { recursive: true });
      yield* fs.writeFileString(`${secretsDir}/${CLOUD_LINKED_USER_ID}.bin`, "user_old");
      yield* fs.writeFileString(
        `${secretsDir}/cloud-cli-oauth-token.bin`,
        JSON.stringify({
          accessToken: "test-access",
          refreshToken: "test-refresh",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          subject,
        }),
      );
      using warning = vi.spyOn(yield* Console.Console, "warn");
      yield* Command.runWith(connectCommand, { version: "0.0.0" })([
        "link",
        "--headless",
        "--publish-only",
        "--base-dir",
        baseDir,
      ]);
      const output = (yield* TestConsole.logLines).join("\n");
      const warnings = warning.mock.calls.flat().join("\n");
      if (mismatch) {
        assert.include(warnings, "different cloud account");
        assert.include(warnings, "`t3 connect unlink`, then `t3 connect link`");
        assert.notInclude(output, "✓ Authorized");
      } else {
        assert.equal(warnings, "");
        assert.include(output, "✓ Authorized");
      }
      yield* Command.runWith(connectCommand, { version: "0.0.0" })([
        "status",
        "--json",
        "--base-dir",
        baseDir,
      ]);
      const status = JSON.parse(String((yield* TestConsole.logLines).at(-1)));
      assert.equal(status.accountMismatch, mismatch);
      assert.equal(status.currentCloudUserId, subject ?? null);
      assert.equal(
        yield* fs.readFileString(`${secretsDir}/${CLOUD_LINKED_USER_ID}.bin`),
        "user_old",
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
    ),
);
