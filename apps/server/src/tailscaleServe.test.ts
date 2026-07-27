import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { TailscaleExecutableProbe } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as TailnetAccess from "./tailnetAccess.ts";
import { configureTailscaleServe, teardownTailscaleServe } from "./tailscaleServe.ts";

const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const LOCAL_PORT = 51_234;
const ENVIRONMENT_ID = "env-under-test";

const encoder = new TextEncoder();

const statusJson = `{"Self":{"DNSName":"m1-dev.tail.ts.net.","TailscaleIPs":["100.109.38.80"]}}`;
const emptyServeConfigJson = "{}";
const nginxServeConfigJson = `{"Web":{"m1-dev.tail.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:80"}}}}}`;

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const mockHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const spawnerLayer = (recorded: Array<SpawnedCommand>, serveConfigJson: string) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const spawned = command as unknown as SpawnedCommand;
      recorded.push({ command: spawned.command, args: [...spawned.args] });
      if (spawned.args[0] === "status") return Effect.succeed(mockHandle(statusJson));
      if (spawned.args[1] === "status") return Effect.succeed(mockHandle(serveConfigJson));
      return Effect.succeed(mockHandle(""));
    }),
  );

/** Ports nothing listens on are "available"; everything else is a live service. */
const netLayer = (availableLoopbackPorts: ReadonlyArray<number>) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: (port: number) =>
      Effect.succeed(availableLoopbackPorts.includes(port)),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort: (preferred: number) => Effect.succeed(preferred),
  } as NetService.NetServiceShape);

const httpLayer = (respond: (url: string) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url))),
    ),
  );

const descriptorResponse = (environmentId: string) =>
  new Response(`{"environmentId":"${environmentId}"}`, {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const runConfigure = (input: {
  readonly recorded: Array<SpawnedCommand>;
  readonly serveConfigJson: string;
  readonly respond: (url: string) => Response;
  readonly availableLoopbackPorts?: ReadonlyArray<number>;
  readonly installedCli?: string | null;
}) =>
  Effect.gen(function* () {
    const tailnetAccess = yield* TailnetAccess.TailnetAccess;
    const configured = yield* configureTailscaleServe({
      localPort: LOCAL_PORT,
      preferredServePort: 443,
      environmentId: ENVIRONMENT_ID,
    });
    return {
      configured,
      advertised: yield* tailnetAccess.getTailnetHttpsBaseUrl,
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TailnetAccess.layer,
        spawnerLayer(input.recorded, input.serveConfigJson),
        netLayer(input.availableLoopbackPorts ?? []),
        httpLayer(input.respond),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(HostProcessEnvironment, { PATH: "/usr/bin:/bin" }),
    Effect.provideService(TailscaleExecutableProbe, (candidate) => {
      const installed = "installedCli" in input ? input.installedCli : MAC_APP_CLI;
      return installed !== null && candidate === installed;
    }),
  );

describe("configureTailscaleServe", () => {
  it.effect("advertises the tailnet URL once the endpoint answers as this environment", () =>
    Effect.gen(function* () {
      const recorded: Array<SpawnedCommand> = [];
      const { configured, advertised } = yield* runConfigure({
        recorded,
        serveConfigJson: emptyServeConfigJson,
        respond: () => descriptorResponse(ENVIRONMENT_ID),
      });

      assert.deepEqual(configured, { localPort: LOCAL_PORT, servePort: 443 });
      assert.equal(advertised, "https://m1-dev.tail.ts.net/");
      assert.deepEqual(
        recorded.map((entry) => entry.args),
        [
          ["serve", "status", "--json"],
          ["serve", "--bg", "--https=443", `http://127.0.0.1:${LOCAL_PORT}`],
          ["status", "--json"],
        ],
      );
      assert.deepEqual(new Set(recorded.map((entry) => entry.command)), new Set([MAC_APP_CLI]));
    }),
  );

  // The reported failure: the app never found the CLI, so no tailnet endpoint
  // was ever advertised and Mac-to-Mac pairing had only a LAN address to offer.
  it.effect("advertises nothing and spawns nothing when the CLI is missing", () =>
    Effect.gen(function* () {
      const recorded: Array<SpawnedCommand> = [];
      const { configured, advertised } = yield* runConfigure({
        recorded,
        serveConfigJson: emptyServeConfigJson,
        respond: () => descriptorResponse(ENVIRONMENT_ID),
        installedCli: null,
      });

      assert.equal(configured, null);
      assert.equal(advertised, null);
      assert.deepEqual(recorded, []);
    }),
  );

  // m1-dev already serves nginx on :443. Taking that mount would break the
  // user's site, and teardown on quit would delete a config we never created.
  it.effect("moves to a fallback port instead of taking a live service's mount", () =>
    Effect.gen(function* () {
      const recorded: Array<SpawnedCommand> = [];
      const { configured, advertised } = yield* runConfigure({
        recorded,
        serveConfigJson: nginxServeConfigJson,
        respond: () => descriptorResponse(ENVIRONMENT_ID),
      });

      assert.deepEqual(configured, { localPort: LOCAL_PORT, servePort: 8443 });
      assert.equal(advertised, "https://m1-dev.tail.ts.net:8443/");
      assert.deepInclude(
        recorded.map((entry) => entry.args),
        ["serve", "--bg", "--https=8443", `http://127.0.0.1:${LOCAL_PORT}`],
      );
    }),
  );

  it.effect("reclaims the preferred port when its mount is stale", () =>
    Effect.gen(function* () {
      const recorded: Array<SpawnedCommand> = [];
      const { configured } = yield* runConfigure({
        recorded,
        serveConfigJson: nginxServeConfigJson,
        respond: () => descriptorResponse(ENVIRONMENT_ID),
        availableLoopbackPorts: [80],
      });

      assert.deepEqual(configured, { localPort: LOCAL_PORT, servePort: 443 });
    }),
  );

  it.effect("does not advertise an endpoint that answers as something else", () =>
    Effect.gen(function* () {
      const recorded: Array<SpawnedCommand> = [];
      const { configured, advertised } = yield* runConfigure({
        recorded,
        serveConfigJson: emptyServeConfigJson,
        respond: () => new Response("<html>404</html>", { status: 404 }),
      });

      // Serve was configured, so teardown still has to undo it...
      assert.deepEqual(configured, { localPort: LOCAL_PORT, servePort: 443 });
      // ...but clients are never handed a URL that does not reach this server.
      assert.equal(advertised, null);
    }),
  );

  it.effect("does not advertise when a different environment answers", () =>
    Effect.gen(function* () {
      const recorded: Array<SpawnedCommand> = [];
      const { advertised } = yield* runConfigure({
        recorded,
        serveConfigJson: emptyServeConfigJson,
        respond: () => descriptorResponse("some-other-environment"),
      });

      assert.equal(advertised, null);
    }),
  );
});

describe("teardownTailscaleServe", () => {
  it.effect("turns off only the port this process configured", () =>
    Effect.gen(function* () {
      const recorded: Array<SpawnedCommand> = [];
      yield* teardownTailscaleServe({ localPort: LOCAL_PORT, servePort: 8443 }).pipe(
        Effect.provide(spawnerLayer(recorded, emptyServeConfigJson)),
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessEnvironment, { PATH: "/usr/bin" }),
        Effect.provideService(TailscaleExecutableProbe, (candidate) => candidate === MAC_APP_CLI),
      );

      assert.deepEqual(
        recorded.map((entry) => entry.args),
        [["serve", "--https=8443", "off"]],
      );
    }),
  );

  it.effect("does nothing when serve was never configured", () =>
    Effect.gen(function* () {
      const recorded: Array<SpawnedCommand> = [];
      yield* teardownTailscaleServe(null).pipe(
        Effect.provide(spawnerLayer(recorded, emptyServeConfigJson)),
      );

      assert.deepEqual(recorded, []);
    }),
  );
});
