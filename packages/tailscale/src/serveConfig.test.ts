import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  loopbackProxyPort,
  loopbackProxyPorts,
  parseTailscaleServeConfig,
  selectTailscaleServePort,
  TailscaleServeConfigParseError,
} from "./serveConfig.ts";

// Verbatim `tailscale serve status --json` shape.
const serveConfigJson = `{
  "TCP": {"443": {"HTTPS": true}},
  "Web": {
    "m1-dev.tail.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:80"}}},
    "m1-dev.tail.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:51234"}}}
  }
}`;

const foregroundServeConfigJson = `{
  "Foreground": {
    "sess-1": {
      "Web": {"m1-dev.tail.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:9"}}}}
    }
  }
}`;

const textHandlerServeConfigJson = `{
  "Web": {"m1-dev.tail.ts.net:443": {"Handlers": {"/": {"Text": "hello"}}}}
}`;

describe("tailscale serve config", () => {
  it.effect("parses an empty config", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleServeConfig("{}"), []);
    }),
  );

  it.effect("parses web mounts per HTTPS port", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleServeConfig(serveConfigJson), [
        { port: 443, proxyTargets: ["http://127.0.0.1:80"] },
        { port: 8443, proxyTargets: ["http://127.0.0.1:51234"] },
      ]);
    }),
  );

  it.effect("counts foreground sessions as occupying their port", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleServeConfig(foregroundServeConfigJson), [
        { port: 443, proxyTargets: ["http://127.0.0.1:9"] },
      ]);
    }),
  );

  it.effect("records a non-proxy handler as an occupied port with no targets", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleServeConfig(textHandlerServeConfigJson), [
        { port: 443, proxyTargets: [] },
      ]);
    }),
  );

  it.effect("keeps serve config decoding failures structured", () =>
    Effect.gen(function* () {
      const error = yield* parseTailscaleServeConfig("{not-json").pipe(Effect.flip);

      assert.instanceOf(error, TailscaleServeConfigParseError);
      assert.equal(error.message, "Failed to decode tailscale serve status JSON.");
    }),
  );

  it.effect("reads loopback ports from proxy targets", () =>
    Effect.sync(() => {
      assert.equal(loopbackProxyPort("http://127.0.0.1:51234"), 51234);
      assert.equal(loopbackProxyPort("http://localhost"), 80);
      assert.equal(loopbackProxyPort("https://localhost"), 443);
      assert.equal(loopbackProxyPort("http://[::1]:8080"), 8080);
      assert.equal(loopbackProxyPort("http://192.168.0.5:8080"), null);
      assert.equal(loopbackProxyPort("not a url"), null);
    }),
  );

  it.effect("collects the distinct loopback ports of a config", () =>
    Effect.gen(function* () {
      const mounts = yield* parseTailscaleServeConfig(serveConfigJson);
      assert.deepEqual(
        [...loopbackProxyPorts(mounts)].sort((a, b) => a - b),
        [80, 51234],
      );
    }),
  );

  describe("serve port selection", () => {
    it.effect("takes the preferred port when nothing is mounted", () =>
      Effect.sync(() => {
        assert.equal(
          selectTailscaleServePort({
            preferredPort: 443,
            localPort: 51234,
            mounts: [],
          }),
          443,
        );
      }),
    );

    it.effect("reuses a port that already points at this server", () =>
      Effect.sync(() => {
        assert.equal(
          selectTailscaleServePort({
            preferredPort: 443,
            localPort: 51234,
            mounts: [{ port: 443, proxyTargets: ["http://127.0.0.1:51234"] }],
          }),
          443,
        );
      }),
    );

    // The reported failure: the node already serves nginx on :443. Taking that
    // mount would break the user's site, and quitting would delete it.
    it.effect("falls back past a port owned by another live service", () =>
      Effect.sync(() => {
        assert.equal(
          selectTailscaleServePort({
            preferredPort: 443,
            localPort: 51234,
            mounts: [{ port: 443, proxyTargets: ["http://127.0.0.1:80"] }],
          }),
          8443,
        );
      }),
    );

    it.effect("reclaims a mount left behind by a dead sidecar", () =>
      Effect.sync(() => {
        assert.equal(
          selectTailscaleServePort({
            preferredPort: 443,
            localPort: 51234,
            mounts: [{ port: 443, proxyTargets: ["http://127.0.0.1:49999"] }],
            isStaleLoopbackPort: (port) => port === 49999,
          }),
          443,
        );
      }),
    );

    it.effect("never claims a mount that proxies off-box", () =>
      Effect.sync(() => {
        assert.equal(
          selectTailscaleServePort({
            preferredPort: 443,
            fallbackPorts: [],
            localPort: 51234,
            mounts: [{ port: 443, proxyTargets: ["http://192.168.0.9:8080"] }],
            isStaleLoopbackPort: () => true,
          }),
          null,
        );
      }),
    );

    it.effect("never claims a port whose handler is not a proxy", () =>
      Effect.sync(() => {
        assert.equal(
          selectTailscaleServePort({
            preferredPort: 443,
            fallbackPorts: [8443],
            localPort: 51234,
            mounts: [
              { port: 443, proxyTargets: [] },
              { port: 8443, proxyTargets: [] },
            ],
          }),
          null,
        );
      }),
    );

    it.effect("returns null when every candidate is taken", () =>
      Effect.sync(() => {
        assert.equal(
          selectTailscaleServePort({
            preferredPort: 443,
            localPort: 51234,
            mounts: [
              { port: 443, proxyTargets: ["http://127.0.0.1:80"] },
              { port: 8443, proxyTargets: ["http://127.0.0.1:81"] },
              { port: 10_000, proxyTargets: ["http://127.0.0.1:82"] },
            ],
          }),
          null,
        );
      }),
    );
  });
});
