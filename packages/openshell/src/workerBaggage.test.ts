import { describe, expect, it } from "vite-plus/test";

import {
  SHARED_CACHE_LANES,
  buildWorkerBaggage,
  templateSpecFromBaggage,
} from "./workerBaggage.ts";

const base = {
  workerClass: "ephemeral" as const,
  mcpEndpoint: "https://managing.example.com/mcp",
  providerHomes: [".claude", ".codex"],
  agentInstructions: ["AGENTS.md"],
  sharedCache: undefined,
};

describe("worker baggage", () => {
  it("copies config homes but never their credentials", () => {
    const baggage = buildWorkerBaggage(base);
    const byName = new Map(baggage.items.map((item) => [item.name, item]));

    expect(byName.get("provider-home:.claude")?.disposition).toBe("copy");
    expect(byName.get("provider-credentials:.claude")?.disposition).toBe("skip");
    expect(byName.get("instructions:AGENTS.md")?.disposition).toBe("copy");
  });

  it("references the managing instance's MCP endpoint instead of copying tools", () => {
    const baggage = buildWorkerBaggage(base);
    const mcp = baggage.items.find((item) => item.name === "mcp:t3");

    expect(mcp?.disposition).toBe("reference");
    expect(mcp?.target).toBe("https://managing.example.com/mcp");
    expect(baggage.env["T3_MCP_ENDPOINT"]).toBe("https://managing.example.com/mcp");
  });

  it("warns instead of pretending when no MCP endpoint is known", () => {
    const baggage = buildWorkerBaggage({ ...base, mcpEndpoint: undefined });

    expect(baggage.items.some((item) => item.name === "mcp:t3")).toBe(false);
    expect(baggage.warnings.join(" ")).toContain("No MCP endpoint");
  });

  it("points every cache lane at the shared volume when one is configured", () => {
    const baggage = buildWorkerBaggage({
      ...base,
      sharedCache: {
        enabled: true,
        mode: "rwx-pvc",
        mountPath: "/opt/t3cache",
        pvcNames: { cache: "cache-pvc", mirrors: "mirrors-pvc" },
      },
    });

    expect(baggage.mounts.map((mount) => mount.target)).toEqual([
      ...SHARED_CACHE_LANES.map((lane) => `/opt/t3cache/${lane.path}`),
      "/opt/t3cache/git-mirrors",
    ]);
    expect(baggage.env["PNPM_STORE_DIR"]).toBe("/opt/t3cache/pnpm-store");
    const mirror = baggage.mounts.find((mount) => mount.target === "/opt/t3cache/git-mirrors");
    expect(mirror?.readOnly).toBe(true);
  });

  it("falls back to the git remote and says so when the cache is off", () => {
    const baggage = buildWorkerBaggage(base);

    expect(baggage.mounts).toHaveLength(0);
    expect(baggage.env["PNPM_STORE_DIR"]).toBeUndefined();
  });

  it("builds a worker template from the baggage", () => {
    const baggage = buildWorkerBaggage(base);
    const spec = templateSpecFromBaggage({
      name: "t3-worker",
      image: "ghcr.io/example/t3-agent:1",
      baggage,
    });

    expect(spec.role).toBe("worker");
    expect(spec.environment["T3_WORKER_CLASS"]).toBe("ephemeral");
    expect(spec.image).toBe("ghcr.io/example/t3-agent:1");
  });
});
