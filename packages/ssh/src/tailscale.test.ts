import { assert, describe, it } from "@effect/vitest";

import {
  inspectRemoteTailscaleServeStatus,
  REMOTE_TAILSCALE_SERVE_SCRIPT,
  RemoteTailscaleServeConflictError,
  REMOTE_TAILSCALE_STATUS_SCRIPT,
  remoteTailscaleEndpoint,
} from "./tailscale.ts";

describe("remote tailscale", () => {
  it("builds a stable HTTPS and WSS endpoint from remote status", () => {
    assert.deepEqual(
      remoteTailscaleEndpoint({
        magicDnsName: "workstation.example.ts.net",
        tailnetIpv4Addresses: ["100.90.1.2"],
      }),
      {
        status: {
          magicDnsName: "workstation.example.ts.net",
          tailnetIpv4Addresses: ["100.90.1.2"],
        },
        httpBaseUrl: "https://workstation.example.ts.net/",
        wsBaseUrl: "wss://workstation.example.ts.net/",
        servePort: 443,
      },
    );
  });

  it("supports non-default Tailscale Serve ports", () => {
    const endpoint = remoteTailscaleEndpoint(
      { magicDnsName: "workstation.example.ts.net", tailnetIpv4Addresses: [] },
      8443,
    );
    assert.equal(endpoint?.httpBaseUrl, "https://workstation.example.ts.net:8443/");
    assert.equal(endpoint?.wsBaseUrl, "wss://workstation.example.ts.net:8443/");
  });

  it("requires MagicDNS for the HTTPS data path", () => {
    assert.isNull(
      remoteTailscaleEndpoint({ magicDnsName: null, tailnetIpv4Addresses: ["100.90.1.2"] }),
    );
  });

  it("uses fixed remote scripts without interpolated ports or commands", () => {
    assert.include(REMOTE_TAILSCALE_STATUS_SCRIPT, "tailscale status --json");
    assert.include(REMOTE_TAILSCALE_SERVE_SCRIPT, 'local_port="$1"');
    assert.include(REMOTE_TAILSCALE_SERVE_SCRIPT, 'serve_port="$2"');
    assert.include(REMOTE_TAILSCALE_SERVE_SCRIPT, "http://127.0.0.1:$local_port");
  });

  it("reuses an existing handler for the same remote T3 server", () => {
    assert.equal(
      inspectRemoteTailscaleServeStatus({
        rawStatusJson: JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: {
            "workstation.example.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
            },
          },
        }),
        localPort: 3773,
        servePort: 443,
      }),
      "configured",
    );
  });

  it("refuses to replace a different handler on the requested HTTPS port", () => {
    assert.throws(
      () =>
        inspectRemoteTailscaleServeStatus({
          rawStatusJson: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: {
              "workstation.example.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } },
              },
            },
          }),
          localPort: 3773,
          servePort: 443,
        }),
      RemoteTailscaleServeConflictError,
    );
  });

  it("allows adding an unused HTTPS port alongside existing Serve config", () => {
    assert.equal(
      inspectRemoteTailscaleServeStatus({
        rawStatusJson: JSON.stringify({
          TCP: { "8443": { HTTPS: true } },
          Web: {
            "workstation.example.ts.net:8443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } },
            },
          },
        }),
        localPort: 3773,
        servePort: 443,
      }),
      "available",
    );
  });
});
