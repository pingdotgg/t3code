import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command } from "effect/cli";

import { acquireRelayClientForLink } from "./connect.ts";
import { connectCommand } from "./up.ts";

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

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("disabled service", (it) => {
  it.effect.each([
    { args: ["login", "--headless"] },
    { args: ["link", "--publish-only", "--headless"] },
    { args: ["link", "--headless"] },
    { args: ["publish"] },
  ])("refuses enabling Connect through $args", ({ args }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-disabled-" });
      yield* fs.writeFileString(`${baseDir}/service.env`, "T3CODE_CONNECT_ENABLED=false\n");
      const error = yield* Effect.flip(
        Command.runWith(connectCommand, { version: "0.0.0" })([...args, "--base-dir", baseDir]),
      );
      assert.include(String(error), "T3CODE_CONNECT_ENABLED=false");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );
});
