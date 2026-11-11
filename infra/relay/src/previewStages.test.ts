import { describe, expect, it } from "vite-plus/test";

import {
  isPreviewStage,
  isPreviewTunnelName,
  isPreviewTunnelRecordName,
  previewSweepTargets,
  tunnelCnameContent,
} from "./previewStages.ts";

const KEY = "0123456789abcdef";

describe("preview stages", () => {
  it("accepts only pull-request stages", () => {
    expect(isPreviewStage("pr-42")).toBe(true);
    expect(isPreviewStage("prod")).toBe(false);
    expect(isPreviewStage("dev_julius")).toBe(false);
    expect(isPreviewStage("pr-0")).toBe(false);
    expect(isPreviewStage("pr-42/../prod")).toBe(false);
  });

  it("matches only tunnels of the exact stage", () => {
    expect(isPreviewTunnelName(`t3coderelay-managedendpoint-pr-42-${KEY}`, "pr-42")).toBe(true);
    expect(isPreviewTunnelName(`t3coderelay-managedendpoint-pr-42-${KEY}`, "pr-4")).toBe(false);
    expect(isPreviewTunnelName(`t3coderelay-managedendpoint-prod-${KEY}`, "pr-42")).toBe(false);
    expect(isPreviewTunnelName(`t3coderelay-managedendpoint-pr-42-xyz`, "pr-42")).toBe(false);
  });

  it("matches only hostnames of the exact stage under the tunnel zone", () => {
    const zone = "tunnels.example.com";
    expect(isPreviewTunnelRecordName(`pr-42-${KEY}.${zone}`, "pr-42", zone)).toBe(true);
    expect(isPreviewTunnelRecordName(`PR-42-${KEY}.Tunnels.example.com`, "pr-42", zone)).toBe(true);
    expect(isPreviewTunnelRecordName(`pr-4-${KEY}.${zone}`, "pr-42", zone)).toBe(false);
    expect(isPreviewTunnelRecordName(`pr-42-${KEY}.other.com`, "pr-42", zone)).toBe(false);
    expect(isPreviewTunnelRecordName(`relay.${zone}`, "pr-42", zone)).toBe(false);
  });

  it("targets only this stage's tunnels and the records that point at them", () => {
    const zone = "tunnels.example.com";
    const mine = `t3coderelay-managedendpoint-pr-42-${KEY}`;
    const otherStage = `t3coderelay-managedendpoint-pr-7-${KEY}`;
    const otherKey = "fedcba9876543210";
    const targets = previewSweepTargets({
      stage: "pr-42",
      tunnelZoneName: zone,
      tunnels: [
        { id: "t-mine", name: mine },
        { id: "t-other", name: otherStage },
      ],
      records: [
        { id: "r-mine", name: `pr-42-${KEY}.${zone}`, content: tunnelCnameContent("t-mine") },
        { id: "r-other", name: `pr-7-${KEY}.${zone}`, content: tunnelCnameContent("t-other") },
        // Right label, but it targets a tunnel outside this sweep.
        { id: "r-stranger", name: `pr-42-${otherKey}.${zone}`, content: "x.cfargotunnel.com" },
      ],
    });
    expect(targets.tunnels.map((tunnel) => tunnel.id)).toEqual(["t-mine"]);
    expect(targets.records.map((record) => record.id)).toEqual(["r-mine"]);
  });
});
