import { describe, expect, it } from "vite-plus/test";
import { mergeAgentLibraries, type McpGatewayProfile } from "./settings.ts";
const profile = (id: string, updatedAt: string, name = id): McpGatewayProfile => ({
  profileId: id,
  name,
  updatedAt,
  createdAt: "2026-01-01",
  revision: 1,
  runtimeMode: "auto",
  interactionMode: "default",
});
describe("agent library convergence", () => {
  it("merges independent edits and converges regardless of environment order", () => {
    const a = {
      mcpGatewayProfiles: [profile("one", "2026-01-03", "New name"), profile("two", "2026-01-01")],
    };
    const b = {
      mcpGatewayProfiles: [
        profile("one", "2026-01-01"),
        { ...profile("two", "2026-01-04"), color: "#123456", icon: "code" as const },
      ],
    };
    const merged = mergeAgentLibraries([a, b]);
    expect(mergeAgentLibraries([b, a])).toEqual(merged);
    expect(merged.mcpGatewayProfiles).toMatchObject([
      { name: "New name" },
      { color: "#123456", icon: "code" },
    ]);
    expect(mergeAgentLibraries([merged, a, b])).toEqual(merged);
  });
  it("does not resurrect a deleted agent when an old device reconnects", () => {
    const stale = { mcpGatewayProfiles: [profile("one", "2026-01-01")] };
    const deleted = { mcpGatewayProfiles: [], mcpGatewayProfileDeletedAt: { one: "2026-01-02" } };
    expect(mergeAgentLibraries([stale, deleted]).mcpGatewayProfiles).toEqual([]);
    expect(mergeAgentLibraries([deleted, stale])).toEqual(mergeAgentLibraries([stale, deleted]));
  });
  it("allows a newer explicit edit while retaining independent agents", () => {
    const merged = mergeAgentLibraries([
      {
        mcpGatewayProfiles: [profile("one", "2026-01-03"), profile("two", "2026-01-01")],
        mcpGatewayProfileDeletedAt: { one: "2026-01-02" },
      },
    ]);
    expect(merged.mcpGatewayProfiles).toHaveLength(2);
  });
});
