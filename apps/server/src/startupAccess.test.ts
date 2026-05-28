import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildPairingUrl,
  formatHeadlessServeOutput,
  renderTerminalQrCode,
  resolveAdvertisedStartupBaseUrl,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";
import { TailscaleServeRuntime } from "./tailscaleServeRuntime.ts";

const encoder = new TextEncoder();

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.succeed(mockHandle(result))),
  );
}

const mockTailscaleServeRuntimeLayer = (configured: boolean) =>
  Layer.succeed(TailscaleServeRuntime, {
    awaitConfigured: Effect.succeed(configured),
    markConfigured: Effect.void,
    markUnavailable: Effect.void,
  });

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it.effect("uses an explicit Tailscale Serve host for the advertised startup base URL", () =>
  Effect.gen(function* () {
    const baseUrl = yield* resolveAdvertisedStartupBaseUrl({
      httpBaseUrl: "http://192.168.1.42:3773",
      tailscaleServeEnabled: true,
      tailscaleServePort: 443,
      tailscaleServeHost: "desktop.tail.ts.net",
    }).pipe(
      Effect.provide(Layer.mergeAll(mockSpawnerLayer({}), mockTailscaleServeRuntimeLayer(true))),
    );

    expect(baseUrl).toBe("https://desktop.tail.ts.net/");
  }),
);

it.effect(
  "resolves the advertised startup base URL from Tailscale status when no host is set",
  () =>
    Effect.gen(function* () {
      const baseUrl = yield* resolveAdvertisedStartupBaseUrl({
        httpBaseUrl: "http://192.168.1.42:3773",
        tailscaleServeEnabled: true,
        tailscaleServePort: 8443,
        tailscaleServeHost: undefined,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            mockSpawnerLayer({
              stdout: `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100"]}}`,
            }),
            mockTailscaleServeRuntimeLayer(true),
          ),
        ),
      );

      expect(baseUrl).toBe("https://desktop.tail.ts.net:8443/");
    }),
);

it.effect("falls back to the HTTP startup base URL when Tailscale status cannot be resolved", () =>
  Effect.gen(function* () {
    const baseUrl = yield* resolveAdvertisedStartupBaseUrl({
      httpBaseUrl: "http://192.168.1.42:3773",
      tailscaleServeEnabled: true,
      tailscaleServePort: 443,
      tailscaleServeHost: undefined,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          mockSpawnerLayer({ code: 1, stderr: "not running" }),
          mockTailscaleServeRuntimeLayer(true),
        ),
      ),
    );

    expect(baseUrl).toBe("http://192.168.1.42:3773");
  }),
);

it.effect("falls back to HTTP when Tailscale Serve setup did not complete", () =>
  Effect.gen(function* () {
    const baseUrl = yield* resolveAdvertisedStartupBaseUrl({
      httpBaseUrl: "http://192.168.1.42:3773",
      tailscaleServeEnabled: true,
      tailscaleServePort: 443,
      tailscaleServeHost: "desktop.tail.ts.net",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          mockSpawnerLayer({
            stdout: `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100"]}}`,
          }),
          mockTailscaleServeRuntimeLayer(false),
        ),
      ),
    );

    expect(baseUrl).toBe("http://192.168.1.42:3773");
  }),
);

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});
