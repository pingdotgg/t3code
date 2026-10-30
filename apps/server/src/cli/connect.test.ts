import * as RelayClient from "@t3tools/shared/relayClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { acquireRelayClientForLink, connectCommand } from "./connect.ts";

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

it.effect.each(["login", "link"] as const)(
  "connect $0 omits the account email from a stored credential",
  (command) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped();
        const secretsDir = path.join(baseDir, "userdata", "secrets");
        yield* fs.makeDirectory(secretsDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(secretsDir, "cloud-cli-oauth-token.bin"),
          JSON.stringify({
            accessToken: "stored-access",
            refreshToken: "stored-refresh",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
            identity: "account@example.test",
          }),
        );

        yield* Command.runWith(connectCommand, { version: "0.0.0" })([
          command,
          "--base-dir",
          baseDir,
          ...(command === "link" ? ["--headless", "--publish-only"] : []),
        ]);

        const output = (yield* TestConsole.logLines).join("\n");
        assert.include(output, command === "login" ? "✓ Signed in" : "✓ Authorized");
        assert.notInclude(output, "account@example.test");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NetService.layer,
          TestConsole.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown({})),
        ),
      ),
    ),
);
