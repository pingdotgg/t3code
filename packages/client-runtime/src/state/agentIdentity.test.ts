import type { McpGatewayProfile, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_ICON_IDS,
  AGENT_ICONS,
  AGENT_ROLE_SUGGESTIONS,
  agentIconFields,
  agentIconFieldsToSave,
  agentIconMatches,
  agentTagOptions,
  environmentAgents,
  normalizeAgentTags,
  resolveAgentIconId,
} from "./agentIdentity.ts";

describe("agent icons", () => {
  it.each([
    [{ iconId: "rocket", icon: "sparkles" as const }, "rocket"],
    // A newer build's id this build does not know falls back to the legacy literal.
    [{ iconId: "hologram", icon: "code" as const }, "code"],
    [{ icon: "terminal" as const }, "terminal"],
    [{}, "orb"],
    [null, "orb"],
  ])("resolves %j to %s", (profile, expected) => {
    expect(resolveAgentIconId(profile)).toBe(expected);
  });

  it("uses kebab-case ids and pairs each with a legacy literal on write", () => {
    for (const id of AGENT_ICON_IDS) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(agentIconFields("database")).toEqual({ iconId: "database", icon: "terminal" });
    expect(agentIconFields("code")).toEqual({ iconId: "code", icon: "code" });
    // Every legacy literal is itself an id, so legacy-only profiles round-trip.
    for (const legacy of new Set(AGENT_ICON_IDS.map((id) => AGENT_ICONS[id].legacy)))
      expect(AGENT_ICON_IDS).toContain(legacy);
  });

  it("keeps an unpicked icon as stored so a newer build's id survives an edit", () => {
    expect(agentIconFieldsToSave({ iconId: "hologram", icon: "bot" }, null)).toEqual({
      iconId: "hologram",
      icon: "bot",
    });
    expect(agentIconFieldsToSave({ icon: "pen" }, null)).toEqual({ iconId: "pen", icon: "pen" });
    expect(agentIconFieldsToSave({ iconId: "hologram" }, "rocket")).toEqual({
      iconId: "rocket",
      icon: "sparkles",
    });
    expect(agentIconFieldsToSave(null, null)).toEqual({ iconId: "orb", icon: "orb" });
    // An id saved without its legacy literal gains the nearest one, or the orb when unknown.
    expect(agentIconFieldsToSave({ iconId: "rocket" }, null)).toEqual({
      iconId: "rocket",
      icon: "sparkles",
    });
    expect(agentIconFieldsToSave({ iconId: "hologram" }, null)).toEqual({
      iconId: "hologram",
      icon: "orb",
    });
  });

  it("searches by label, keyword, and category, requiring every word", () => {
    expect(agentIconMatches("git-pull-request", "review")).toBe(true);
    expect(agentIconMatches("palette", "ART")).toBe(true);
    expect(agentIconMatches("bug", "debug qa")).toBe(true);
    expect(agentIconMatches("bug", "debug music")).toBe(false);
    expect(agentIconMatches("bug", "  ")).toBe(true);
  });
});

describe("agent role tags", () => {
  it("normalizes tags: trims, dedupes case-insensitively, keeps canonical role casing, caps count", () => {
    expect(normalizeAgentTags([" dev ", "DEV", "Growth  hacking", "", "growth hacking"])).toEqual([
      "Dev",
      "Growth hacking",
    ]);
    expect(normalizeAgentTags(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(8);
    expect(normalizeAgentTags(["x".repeat(40)])[0]).toHaveLength(32);
  });

  it("offers every suggested role plus every saved custom tag, uncapped", () => {
    expect(agentTagOptions(["alpha", "dev", "beta", "gamma"])).toEqual([
      ...AGENT_ROLE_SUGGESTIONS,
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

describe("environmentAgents", () => {
  const doug: McpGatewayProfile = {
    profileId: "prof-doug",
    name: "Doug",
    runtimeMode: "auto",
    interactionMode: "default",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const config = (agentLibraryMutations: boolean | undefined, profiles: McpGatewayProfile[]) =>
    ({
      environment: { capabilities: { agentLibraryMutations } },
      settings: { mcpGatewayProfiles: profiles },
    }) as unknown as Pick<ServerConfig, "environment" | "settings">;

  it("offers only the environment's own agents, and none on a server that drops agent records", () => {
    expect(environmentAgents(null)).toEqual({ status: "loading" });
    expect(environmentAgents(config(undefined, [doug]))).toEqual({ status: "unsupported" });
    expect(environmentAgents(config(true, [doug]))).toEqual({ status: "ready", profiles: [doug] });
  });

  it("keeps the previous value when a config push leaves the agents unchanged", () => {
    const first = environmentAgents(config(true, [doug]));
    expect(environmentAgents(config(true, [{ ...doug }]), first)).toBe(first);
    expect(environmentAgents(config(true, [{ ...doug, name: "Douglas" }]), first)).not.toBe(first);
  });
});
