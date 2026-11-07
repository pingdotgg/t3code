import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { descriptorOf, servePeer } from "../peer/PeerLinks.testkit.ts";

const runCli = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.andThen(TestConsole.logLines),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        TestConsole.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

it.effect("links with the pairing code from T3CODE_PAIRING_CODE, or --pairing-code over it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const peer = yield* servePeer(descriptorOf("cli-link-peer", "Box"), Layer.empty);
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-environment-link-" });
    yield* fs.makeDirectory(path.join(baseDir, "userdata"));
    yield* fs.writeFileString(
      path.join(baseDir, "userdata", "settings.json"),
      JSON.stringify({ linkedEnvironmentsEnabled: true }),
    );
    const link = ["environment", "link", peer.url, "--base-dir", baseDir];

    const spent = (yield* peer.auth.issuePairingCredential()).credential;
    expect(yield* runCli(link, { T3CODE_PAIRING_CODE: spent })).toContainEqual(
      expect.stringContaining("Linked Box (cli-link-peer)"),
    );

    // The env code is spent now, so this links only if the flag wins.
    const fresh = (yield* peer.auth.issuePairingCredential()).credential;
    expect(
      yield* runCli([...link, "--pairing-code", fresh], { T3CODE_PAIRING_CODE: spent }),
    ).toContainEqual(expect.stringContaining("Linked Box (cli-link-peer)"));
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
