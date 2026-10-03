// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../binCli.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  DevServerNotProxiableError,
  resolveDirectPairingBaseUrl,
  resolveTailscaleLocalTarget,
} from "./pair.ts";

import packageJson from "../../package.json" with { type: "json" };

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const baseState = {
  version: 1,
  pid: 123,
  port: 3_773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-06-20T00:00:00.000Z",
} as const satisfies PersistedServerRuntimeState;

describe("pair base URL selection", () => {
  it("pairs through the dev web origin when the server fronts a dev server", () => {
    expect(resolveDirectPairingBaseUrl({ ...baseState, devUrl: "http://localhost:5733/" })).toBe(
      "http://localhost:5733/",
    );
  });

  it("pairs through the bound host when there is no dev server", () => {
    expect(resolveDirectPairingBaseUrl({ ...baseState, host: "100.64.0.7" })).toBe(
      "http://100.64.0.7:3773",
    );
    expect(resolveDirectPairingBaseUrl(baseState)).toBe("http://localhost:3773");
  });
});

describe("pair tailscale local target", () => {
  it("proxies the dev web port for dev servers", () => {
    expect(resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://localhost:5733/" })).toEqual(
      { localPort: 5_733 },
    );
    // A dev server on a non-loopback interface must be proxied at that
    // interface; tailscale serve defaults to 127.0.0.1 otherwise.
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://192.168.1.10:5733/" }),
    ).toEqual({ localPort: 5_733, localHost: "192.168.1.10" });
    // URL.hostname keeps IPv6 brackets, so the serve target stays valid.
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://[fd7a:115c::1]:5733/" }),
    ).toEqual({ localPort: 5_733, localHost: "[fd7a:115c::1]" });
  });

  it("rejects HTTPS dev URLs, which tailscale serve cannot proxy", () => {
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "https://localhost:5733/" }),
    ).toBeInstanceOf(DevServerNotProxiableError);
  });

  it("proxies the backend port directly otherwise", () => {
    expect(resolveTailscaleLocalTarget(baseState)).toEqual({ localPort: 3_773 });
    expect(resolveTailscaleLocalTarget({ ...baseState, host: "0.0.0.0" })).toEqual({
      localPort: 3_773,
    });
    expect(resolveTailscaleLocalTarget({ ...baseState, host: "192.168.1.42" })).toEqual({
      localPort: 3_773,
      localHost: "192.168.1.42",
    });
  });
});

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(CliRuntimeLayer, TestConsole.layer));

// Console output accumulates across CLI runs within a test, and each
// Console.log call is one entry — so the latest command's output is the last
// entry, even when it spans many lines.
const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

const testDescriptor = {
  environmentId: "pair-test-environment",
  label: "pair-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
};

const withProbeServer = <A, E, R>(
  { status, contentType, body }: { status: number; contentType: string; body: string },
  run: (baseDir: string, origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/.well-known/t3/environment") {
            response.writeHead(status, { "content-type": contentType });
            response.end(body);
            return;
          }
          response.writeHead(404);
          response.end();
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.gen(function* () {
          const address = server.address();
          if (address === null || typeof address === "string") {
            return yield* Effect.die(new Error("Expected a TCP address"));
          }
          const fs = yield* FileSystem.FileSystem;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pair-probe-test-" });
          yield* persistServerRuntimeState({
            path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            state: yield* makePersistedServerRuntimeState({
              config: { host: "127.0.0.1", devUrl: undefined },
              port: address.port,
            }),
          });
          return yield* run(baseDir, `http://127.0.0.1:${String(address.port)}`);
        }),
      (server) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    ),
  );

const assertPairRejected = (baseDir: string) =>
  Effect.gen(function* () {
    const error = yield* provideCliTestLayers(
      runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
    );
    const rendered = String(
      typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
    );
    assert.include(rendered, "No running T3 Code server found.");
  });

const withDescriptorServer = <A, E, R>(run: (origin: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(testDescriptor));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("t3 pair", () => {
  it.effect("mints a token and prints a QR pairing URL for a live server", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-test-"));
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port,
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, `Pairing with pair-test (${origin})`);
        assert.include(output, `Pairing URL: ${origin}/pair#token=`);
        assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
        // Loopback origins are not reachable from a phone; the output must say so.
        assert.include(output, "only reachable from this machine");

        const token = /#token=([A-Z2-9]+)/.exec(output)?.[1];
        assert.isString(token);

        // The token must be in the same store the running server reads.
        const listed = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
        const credentials = JSON.parse(listed) as ReadonlyArray<{ readonly label?: string }>;
        assert.equal(credentials.length, 1);
        assert.equal(credentials[0]?.label, "t3 pair");
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessEnvironment, {
        ...process.env,
        [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          childVersion: packageJson.version,
        }),
      }),
      Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, {
        connected: false,
        send: () => false,
        on: () => undefined,
        off: () => undefined,
      }),
    ),
  );

  it.effect("pairs through the recorded dev web URL for dev servers", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-dev-test-"));
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "dev", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: undefined, devUrl: new URL("http://localhost:5733") },
            port,
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, "Pairing URL: http://localhost:5733/pair#token=");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("directs to t3 serve or t3 connect when no server is running", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-none-test-"));

      const error = yield* provideCliTestLayers(
        runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
      );

      const rendered = String(
        typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
      );
      assert.include(rendered, "No running T3 Code server found.");
      assert.include(rendered, "npx t3 serve");
      assert.include(rendered, "npx t3 connect");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores runtime state whose recorded pid is no longer alive", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-pid-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        // The origin answers (another server reused the port), but the pid
        // that wrote this state file is dead — pairing must not mint a token
        // into the dead server's database.
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: Number(new URL(origin).port),
        });
        yield* persistServerRuntimeState({
          path: statePath,
          // pid 2**22 + 1 exceeds any default Linux/macOS pid range.
          state: { ...state, pid: 4_194_305 },
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );

        const rendered = String(
          typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
        );
        assert.include(rendered, "No running T3 Code server found.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores stale runtime state pointing at a dead server", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-stale-test-"));
      const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
      // A port from the dynamic range with nothing listening: the probe fails
      // fast with ECONNREFUSED and discovery moves on.
      yield* persistServerRuntimeState({
        path: statePath,
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 1,
        }),
      });

      const error = yield* provideCliTestLayers(
        runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
      );

      const rendered = String(
        typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
      );
      assert.include(rendered, "No running T3 Code server found.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not decode an oversized stranger body as a server descriptor", () =>
    withProbeServer(
      {
        status: 200,
        contentType: "application/json",
        // Schema-valid JSON that would pair without the byte cap.
        body: JSON.stringify({ ...testDescriptor, padding: "x".repeat(128 * 1024) }),
      },
      assertPairRejected,
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a descriptor that exceeds the cap in UTF-8 bytes only", () =>
    withProbeServer(
      {
        status: 200,
        contentType: "application/json",
        // Two UTF-8 bytes per character: below 64 KiB in string length,
        // above it on the wire. A string-length cap would accept this.
        body: JSON.stringify({ ...testDescriptor, label: "é".repeat(40 * 1024) }),
      },
      assertPairRejected,
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not pair when a valid descriptor arrives as non-JSON", () =>
    withProbeServer(
      {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: JSON.stringify(testDescriptor),
      },
      assertPairRejected,
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not pair when a valid descriptor arrives with an error status", () =>
    withProbeServer(
      { status: 500, contentType: "application/json", body: JSON.stringify(testDescriptor) },
      assertPairRejected,
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pairs when the descriptor arrives with an uppercase JSON content type", () =>
    withProbeServer(
      {
        status: 200,
        contentType: "Application/JSON; charset=utf-8",
        body: JSON.stringify(testDescriptor),
      },
      (baseDir) =>
        Effect.gen(function* () {
          const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));
          assert.include(output, "Pairing with pair-test (");
          assert.include(output, "/pair#token=");
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("times out a slow-drip stranger body instead of hanging discovery", () => {
    // Handoff from the raw Node request handler below: it holds the response
    // open so the test fiber can drip into it. Completed synchronously from
    // the callback via `doneUnsafe`, so no manual Effect runtime is created
    // in the test (see `t3code(no-manual-effect-runtime-in-tests)`).
    const dripTarget = Deferred.makeUnsafe<NodeHttp.ServerResponse>();
    return Effect.acquireUseRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/.well-known/t3/environment") {
            response.writeHead(200, { "content-type": "application/json" });
            // A never-ending drip that stays under the size cap: discovery
            // must give up via the body timeout rather than hang on the open
            // stream.
            response.write(`{"environmentId":`);
            Deferred.doneUnsafe(dripTarget, Effect.succeed(response));
            return;
          }
          response.writeHead(404);
          response.end();
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.scoped(
          Effect.gen(function* () {
            const address = server.address();
            if (address === null || typeof address === "string") {
              return yield* Effect.die(new Error("Expected a TCP address"));
            }
            const baseDir = NodeFS.mkdtempSync(
              NodePath.join(NodeOS.tmpdir(), "t3-pair-drip-test-"),
            );
            const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
            yield* persistServerRuntimeState({
              path: statePath,
              state: yield* makePersistedServerRuntimeState({
                config: { host: "127.0.0.1", devUrl: undefined },
                port: address.port,
              }),
            });

            const cliFiber = yield* provideCliTestLayers(
              runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
            ).pipe(Effect.forkChild);
            // The probe request holds the response open; the drip loop is a
            // scoped fork, so it is interrupted when the test settles.
            const dripResponse = yield* Deferred.await(dripTarget);
            yield* Effect.repeat(
              Effect.sync(() => {
                if (!dripResponse.destroyed) {
                  dripResponse.write(" ");
                }
              }),
              Schedule.spaced("200 millis"),
            ).pipe(Effect.forkScoped);

            const error = yield* Fiber.join(cliFiber);

            const rendered = String(
              typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
            );
            assert.include(rendered, "No running T3 Code server found.");
          }),
        ),
      (server) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    ).pipe(Effect.provide(NodeServices.layer));
  });
});
