import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { createAdvertisedEndpoint } from "./endpoint.ts";
import {
  advertisedDefaultEndpoint,
  probeEnvironmentEndpoint,
  resolveAdoptableAdvertisedEndpoint,
} from "./endpointAdoption.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";

const TAILNET_ENDPOINT = createAdvertisedEndpoint({
  id: "tailscale-serve",
  label: "Tailscale",
  provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: false },
  httpBaseUrl: "https://magic.tailnet.example/",
  reachability: "private-network",
  source: "server",
  isDefault: true,
});
const DIRECT_ENDPOINT = createAdvertisedEndpoint({
  id: "direct",
  label: "Direct",
  provider: { id: "core", label: "Direct", kind: "core", isAddon: false },
  httpBaseUrl: "http://192.168.1.10:3773/",
  reachability: "lan",
  source: "server",
});

describe("advertisedDefaultEndpoint", () => {
  it("returns none when the descriptor advertises nothing", () => {
    expect(
      advertisedDefaultEndpoint({
        advertisedEndpoints: undefined,
        currentHttpBaseUrl: "http://192.168.1.10:3773/",
      }),
    ).toEqual(Option.none());
  });

  it("returns none when only a direct endpoint is advertised", () => {
    expect(
      advertisedDefaultEndpoint({
        advertisedEndpoints: [DIRECT_ENDPOINT],
        currentHttpBaseUrl: "http://192.168.1.10:3773/",
      }),
    ).toEqual(Option.none());
  });

  it("returns none when the default matches the current base URL after normalization", () => {
    expect(
      advertisedDefaultEndpoint({
        advertisedEndpoints: [TAILNET_ENDPOINT, DIRECT_ENDPOINT],
        currentHttpBaseUrl: "https://magic.tailnet.example",
      }),
    ).toEqual(Option.none());
  });

  it("preserves the advertised websocket URL", () => {
    const endpoint = { ...TAILNET_ENDPOINT, wsBaseUrl: "wss://socket.tailnet.example:4443/ws" };
    expect(
      advertisedDefaultEndpoint({
        advertisedEndpoints: [endpoint, DIRECT_ENDPOINT],
        currentHttpBaseUrl: "http://192.168.1.10:3773/",
      }),
    ).toEqual(
      Option.some({
        httpBaseUrl: "https://magic.tailnet.example/",
        wsBaseUrl: "wss://socket.tailnet.example:4443/ws",
      }),
    );
  });

  it("returns none when the advertised default URL is invalid", () => {
    expect(
      advertisedDefaultEndpoint({
        advertisedEndpoints: [{ ...TAILNET_ENDPOINT, httpBaseUrl: "::not-a-url::" }],
        currentHttpBaseUrl: "http://192.168.1.10:3773/",
      }),
    ).toEqual(Option.none());
  });

  it("skips a default endpoint marked unavailable", () => {
    expect(
      advertisedDefaultEndpoint({
        advertisedEndpoints: [{ ...TAILNET_ENDPOINT, status: "unavailable" }],
        currentHttpBaseUrl: "http://192.168.1.10:3773/",
      }),
    ).toEqual(Option.none());
  });
});

describe("probeEnvironmentEndpoint", () => {
  function probeLayer(calls: Array<string>, response: () => Promise<Response>) {
    return remoteHttpClientLayer(((input) => {
      calls.push(String(input));
      return response();
    }) satisfies typeof fetch);
  }

  it.effect("returns true for a 2xx response", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const reachable = yield* probeEnvironmentEndpoint({
        httpBaseUrl: "https://magic.tailnet.example/",
        expectedEnvironmentId: EnvironmentId.make("environment-paired"),
      }).pipe(
        Effect.provide(
          probeLayer(calls, () =>
            Promise.resolve(
              Response.json({
                environmentId: "environment-paired",
                label: "Paired environment",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
            ),
          ),
        ),
      );

      expect(reachable).toBe(true);
      expect(calls).toEqual(["https://magic.tailnet.example/.well-known/t3/environment"]);
    }),
  );

  it.effect("returns false when the descriptor belongs to another environment", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const reachable = yield* probeEnvironmentEndpoint({
        httpBaseUrl: "https://magic.tailnet.example/",
        expectedEnvironmentId: EnvironmentId.make("environment-paired"),
      }).pipe(
        Effect.provide(
          probeLayer(calls, () =>
            Promise.resolve(
              Response.json({
                environmentId: "different-environment",
                label: "Other environment",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
            ),
          ),
        ),
      );

      expect(reachable).toBe(false);
    }),
  );

  it.effect("returns false for a non-2xx response", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const reachable = yield* probeEnvironmentEndpoint({
        httpBaseUrl: "https://magic.tailnet.example/",
        expectedEnvironmentId: EnvironmentId.make("environment-paired"),
      }).pipe(
        Effect.provide(
          probeLayer(calls, () => Promise.resolve(Response.json({}, { status: 503 }))),
        ),
      );

      expect(reachable).toBe(false);
    }),
  );

  it.effect("returns false when the request fails", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const reachable = yield* probeEnvironmentEndpoint({
        httpBaseUrl: "https://magic.tailnet.example/",
        expectedEnvironmentId: EnvironmentId.make("environment-paired"),
      }).pipe(
        Effect.provide(probeLayer(calls, () => Promise.reject(new Error("network unreachable")))),
      );

      expect(reachable).toBe(false);
    }),
  );
});

describe("resolveAdoptableAdvertisedEndpoint", () => {
  it.effect("does not probe when nothing is adoptable", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const adopted = yield* resolveAdoptableAdvertisedEndpoint({
        advertisedEndpoints: [DIRECT_ENDPOINT],
        currentHttpBaseUrl: "http://192.168.1.10:3773/",
        expectedEnvironmentId: EnvironmentId.make("environment-paired"),
      }).pipe(
        Effect.provide(
          remoteHttpClientLayer(((input) => {
            calls.push(String(input));
            return Promise.resolve(Response.json({}));
          }) satisfies typeof fetch),
        ),
      );

      expect(adopted).toEqual(Option.none());
      expect(calls).toEqual([]);
    }),
  );
});
