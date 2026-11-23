// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { descriptorOf, servePeer } from "../peer/PeerLinks.testkit.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

/** The batch reports printed so far; the logger writes to the same console. */
const reports = TestConsole.logLines.pipe(
  Effect.map((lines) =>
    lines.filter((line): line is string => typeof line === "string" && line.includes(" linked.")),
  ),
);

/** A machine of the fleet, on a socket of its own. */
const serveMachine = (descriptor: ExecutionEnvironmentDescriptor) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      servePeer(descriptor, Layer.empty).pipe(Effect.provideContext(server)),
    ),
  );

it.effect("links a file of environments, reports each line, and fails when one did not link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-environment-cli-" });
      const { settingsPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(NodePath.dirname(settingsPath), { recursive: true });
      yield* fs.writeFileString(settingsPath, JSON.stringify({ linkedEnvironmentsEnabled: true }));

      const one = yield* serveMachine(descriptorOf("environment-vm-1", "VM 1"));
      const two = yield* serveMachine(descriptorOf("environment-vm-2", "VM 2"));
      const three = yield* serveMachine(descriptorOf("environment-vm-3", "VM 3"));
      const codeFor = (machine: typeof one) =>
        machine.auth
          .issuePairingCredential({ access: "auto", purpose: "peer-link" })
          .pipe(Effect.map((pairing) => pairing.credential));
      const firstCode = yield* codeFor(one);
      const thirdCode = yield* codeFor(three);

      const file = NodePath.join(baseDir, "fleet.txt");
      yield* fs.writeFileString(
        file,
        `# fleet\n${one.url} ${firstCode}\n\n${two.url} not-a-code\n${three.url} ${thirdCode}\n`,
      );
      const link = (from: string) =>
        runCli(["environment", "link", "--from", from, "--access", "auto", "--base-dir", baseDir]);

      const conflict = yield* runCli([
        "environment",
        "link",
        "--from",
        file,
        "--url",
        "http://ignored.invalid",
        "--access",
        "auto",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "EnvironmentLinkUsageError",
        detail: "--from takes its addresses and pairing codes from the file.",
      });

      const failed = yield* link(file).pipe(Effect.flip);
      expect(failed).toMatchObject({ _tag: "EnvironmentLinkBatchError", failed: 1, total: 3 });
      const report = (yield* reports).at(-1) ?? "";
      expect(report).toContain(`${one.url}: linked VM 1 (environment-vm-1) with auto access`);
      expect(report).toContain(`${two.url}: code refused: `);
      expect(report).toContain(`${three.url}: linked VM 3 (environment-vm-3) with auto access`);
      expect(report).toContain("2 of 3 linked.");
      // A pairing code is never printed, whether it worked or not.
      expect(report).not.toContain(firstCode);
      expect(report).not.toContain("not-a-code");
      expect((yield* one.linkedSessions).length).toBe(1);
      expect(yield* two.linkedSessions).toEqual([]);
      expect((yield* three.linkedSessions).length).toBe(1);

      // Retrying the whole file links the failure and leaves the linked ones alone,
      // their codes unused: the first is spent and the third was never valid.
      const retry = NodePath.join(baseDir, "retry.txt");
      yield* fs.writeFileString(
        retry,
        `${one.url} ${firstCode}\n${two.url} ${yield* codeFor(two)}\n${three.url} never-valid\n`,
      );
      yield* link(retry);
      const retried = (yield* reports).at(-1) ?? "";
      expect(retried).toContain(
        `${one.url}: already linked as VM 1 (environment-vm-1), left as it is`,
      );
      expect(retried).toContain(`${two.url}: linked VM 2 (environment-vm-2) with auto access`);
      expect(retried).toContain(
        `${three.url}: already linked as VM 3 (environment-vm-3), left as it is`,
      );
      expect(retried).toContain("3 of 3 linked.");
      expect((yield* one.linkedSessions).length).toBe(1);
      expect((yield* two.linkedSessions).length).toBe(1);
      expect((yield* three.linkedSessions).length).toBe(1);

      // An address may carry credentials; a result line names only its origin.
      const withSecrets = (url: string) =>
        Object.assign(new URL(url), {
          username: "alice",
          password: "hunter2",
          search: "?token=s3cret",
        }).href;
      const secrets = NodePath.join(baseDir, "secrets.txt");
      yield* fs.writeFileString(
        secrets,
        [
          `${withSecrets(one.url)} ${firstCode}`,
          `${withSecrets("http://192.168.1.20:3773")} some-code`,
          `ftp://alice:hunter2@files.example/?token=s3cret some-code`,
        ].join("\n"),
      );
      yield* link(secrets).pipe(Effect.flip);
      const redacted = (yield* reports).at(-1) ?? "";
      expect(redacted).toContain(`${new URL(one.url).origin}: already linked as VM 1`);
      expect(redacted).toContain("http://192.168.1.20:3773: unreachable: ");
      expect(redacted).toContain("line 3: unreachable: ");
      expect(redacted).not.toMatch(/alice|hunter2|s3cret/);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(layerCliRuntime, TestConsole.layer))),
);
