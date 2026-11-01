// @effect-diagnostics nodeBuiltinImport:off -- Exercises CLI subprocess shutdown against a local relay fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  decodeConfirmedOrigin,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./cloud/config.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "./cloud/CliState.ts";
import { makeProcessProbe, processProbeSource } from "./testUtils/processProbe.ts";

it.live("retains a managed tunnel on server shutdown and reuses it after restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const net = yield* NetService.NetService;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tunnel-lifecycle-" });
    const secretsDir = path.join(root, "userdata", "secrets");
    yield* fs.makeDirectory(secretsDir, { recursive: true });
    const requests: string[] = [];
    const relay = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = NodeHttp.createServer((request, response) => {
          requests.push(`${request.method} ${request.url}`);
          request.resume();
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify(request.method === "DELETE" ? { ok: true } : { status: "ready" }),
          );
        });
        server.listen(0, "127.0.0.1");
        await NodeEvents.EventEmitter.once(server, "listening");
        return server;
      }),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = relay.address();
    if (address === null || typeof address === "string") return yield* Effect.die("No relay port");
    const relayUrl = `http://127.0.0.1:${address.port}`;
    const port = yield* net.reserveLoopbackPort();
    const config = {
      providerKind: "cloudflare_tunnel",
      tunnelId: "existing-tunnel",
      connectorToken: "existing-token",
    };
    const configJson = JSON.stringify(config);
    const confirmedOrigin = {
      config,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: port },
    };
    yield* Effect.forEach(
      Object.entries({
        [CLOUD_ENDPOINT_RUNTIME_CONFIG]: configJson,
        [CLOUD_ENDPOINT_CONFIRMED_ORIGIN]: JSON.stringify(confirmedOrigin),
        [CLOUD_CLI_DESIRED_LINK_SECRET]: "managed",
        [CLOUD_LINKED_USER_ID]: "user-123",
        [RELAY_URL_SECRET]: relayUrl,
        [RELAY_ISSUER_SECRET]: "https://relay.example.test",
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET]: "environment-credential",
        "cloud-cli-oauth-token": JSON.stringify({
          accessToken: "cli-access-token",
          refreshToken: "cli-refresh-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        }),
      }),
      ([name, value]) => fs.writeFileString(path.join(secretsDir, `${name}.bin`), value),
    );
    yield* fs.writeFileString(path.join(root, "userdata", "environment-id"), "env_123");
    const bin = yield* path.fromFileUrl(new URL("./bin.ts", import.meta.url));
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:T3CODE_|VITE_)/u.test(name)),
    );

    const startAndStop = Effect.fn("test.managedTunnel.startAndStop")(
      function* () {
        const connector = yield* makeProcessProbe;
        const preload = path.join(root, `connector-${connector.port}.mjs`);
        // Node acts as cloudflared so the fixture also works without a shell launcher on Windows.
        yield* fs.writeFileString(
          preload,
          `
          import { basename } from "node:path";
          const command = basename(process.argv[1] ?? "");
          if (command === "version") {
            console.log("cloudflared version 2026.10.4");
            process.exit(0);
          }
          if (command === "tunnel") {
            ${processProbeSource(connector.port)}
            console.error("INF Registered tunnel connection connIndex=0");
            await new Promise((resolve) => probe.on("close", resolve));
            process.exit(0);
          }
          process.on("message", (message) => {
            if (message === "shutdown") process.emit("SIGTERM");
          });
        `,
        );
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.fork(
              bin,
              ["serve", "--base-dir", root, "--host", "127.0.0.1", "--port", String(port)],
              {
                cwd: root,
                execArgv: [],
                silent: true,
                env: {
                  ...inheritedEnv,
                  NODE_OPTIONS: `--import=${NodeURL.pathToFileURL(preload).href}`,
                  T3CODE_CLOUDFLARED_PATH: process.execPath,
                  T3CODE_RELAY_URL: "https://relay.example.test",
                  T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`,
                  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "test-client",
                  T3CODE_TELEMETRY_ENABLED: "false",
                },
              },
            ),
          ),
          (process) =>
            Effect.promise(async () => {
              if (
                process.pid === undefined ||
                process.exitCode !== null ||
                process.signalCode !== null
              )
                return;
              const exited = NodeEvents.EventEmitter.once(process, "close");
              process.kill("SIGKILL");
              await exited;
            }),
        );
        const ready = Promise.withResolvers<void>();
        const exited = NodeEvents.EventEmitter.once(child, "close");
        let output = "";
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (
              output.includes("T3 Code server is ready.") &&
              output.includes("T3 Connect managed tunnel recovery registered") &&
              output.includes("Relay client tunnel connection registered")
            ) {
              ready.resolve();
            }
          });
        }
        yield* Effect.promise(() =>
          Promise.race([
            ready.promise,
            exited.then(() => {
              throw new Error(`Server exited before tunnel registration:\n${output}`);
            }),
          ]),
        );
        yield* connector.started;
        yield* Effect.promise(async () => {
          child.send("shutdown");
          await exited;
        });
        yield* connector.exited;
        expect(output).toContain("V2 orchestration shutdown reconciliation completed");
      },
      Effect.scoped,
      // The shared process probe uses TestClock.withLive for its event deadlines.
      Effect.provide(TestClock.layer()),
    );

    yield* startAndStop();
    expect(requests).toEqual(["POST /v1/environments/env_123/tunnel/recovery"]);
    expect(
      yield* fs.readFileString(path.join(secretsDir, `${CLOUD_ENDPOINT_RUNTIME_CONFIG}.bin`)),
    ).toBe(configJson);
    expect(
      decodeConfirmedOrigin(
        yield* fs.readFileString(path.join(secretsDir, `${CLOUD_ENDPOINT_CONFIRMED_ORIGIN}.bin`)),
      ),
    ).toEqual(Option.some(confirmedOrigin));

    yield* startAndStop();
    expect(requests).toEqual([
      "POST /v1/environments/env_123/tunnel/recovery",
      "POST /v1/environments/env_123/tunnel/recovery",
    ]);
    expect(
      yield* fs.readFileString(path.join(secretsDir, `${CLOUD_ENDPOINT_RUNTIME_CONFIG}.bin`)),
    ).toBe(configJson);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);
