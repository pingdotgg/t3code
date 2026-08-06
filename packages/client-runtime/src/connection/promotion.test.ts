import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { selectPromotionCandidates } from "./promotion.ts";

function endpoint(input: {
  readonly id: string;
  readonly httpBaseUrl: string;
  readonly reachability: AdvertisedEndpoint["reachability"];
  readonly status?: AdvertisedEndpoint["status"];
}): AdvertisedEndpoint {
  return {
    id: input.id,
    label: input.id,
    provider: { id: "server-core", label: "Server", kind: "core", isAddon: false },
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.httpBaseUrl.replace("http", "ws"),
    reachability: input.reachability,
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "server",
    status: input.status ?? "available",
  };
}

const RELAY_BASE_URL = "https://tunnel.example.test/";

describe("selectPromotionCandidates", () => {
  it("keeps direct lan and private-network endpoints, preferring lan", () => {
    const candidates = selectPromotionCandidates({
      endpoints: [
        endpoint({
          id: "tailscale-ip:http://100.64.0.7:3773",
          httpBaseUrl: "http://100.64.0.7:3773/",
          reachability: "private-network",
        }),
        endpoint({
          id: "server-lan:http://192.168.1.20:3773",
          httpBaseUrl: "http://192.168.1.20:3773/",
          reachability: "lan",
        }),
      ],
      currentHttpBaseUrl: RELAY_BASE_URL,
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "server-lan:http://192.168.1.20:3773",
      "tailscale-ip:http://100.64.0.7:3773",
    ]);
  });

  it("excludes loopback, public, unavailable, and current-route endpoints", () => {
    const candidates = selectPromotionCandidates({
      endpoints: [
        endpoint({
          id: "server-loopback:3773",
          httpBaseUrl: "http://127.0.0.1:3773/",
          reachability: "loopback",
        }),
        endpoint({
          id: "server-public:http://203.0.113.5:3773",
          httpBaseUrl: "http://203.0.113.5:3773/",
          reachability: "public",
        }),
        endpoint({
          id: "tailscale-magicdns:https://machine.tail.ts.net/",
          httpBaseUrl: "https://machine.tail.ts.net/",
          reachability: "private-network",
          status: "unavailable",
        }),
        endpoint({
          id: "server-lan:http://192.168.1.20:3773",
          httpBaseUrl: "http://192.168.1.20:3773",
          reachability: "lan",
        }),
      ],
      // Already connected through the LAN route (normalization makes the
      // trailing-slash difference irrelevant).
      currentHttpBaseUrl: "http://192.168.1.20:3773/",
    });
    expect(candidates).toEqual([]);
  });

  it("excludes endpoints cooling down after a failed promotion", () => {
    const candidates = selectPromotionCandidates({
      endpoints: [
        endpoint({
          id: "server-lan:http://192.168.1.20:3773",
          httpBaseUrl: "http://192.168.1.20:3773/",
          reachability: "lan",
        }),
      ],
      currentHttpBaseUrl: RELAY_BASE_URL,
      cooldownEndpointIds: new Set(["server-lan:http://192.168.1.20:3773"]),
    });
    expect(candidates).toEqual([]);
  });
});
