import { AgentProfileId, AgentProfileRevision, type AgentProfileSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentProfilePickerLabel,
  filterAgentProfiles,
  selectChatAgentProfiles,
} from "./AgentProfilePicker.logic";

const revision = AgentProfileRevision.make("a".repeat(64));
const profiles = [
  {
    id: AgentProfileId.make("sol-planner"),
    scope: "environment" as const,
    revision,
    name: "Sol Planner",
    description: "Architecture and implementation plans",
    defaultModelSelection: null,
    chatSelectable: true,
    sourcePath: null,
    requirements: { t3McpCapabilities: [], toolRequirement: "none" as const },
    archivedAt: null,
    updatedAt: "2026-08-07T12:00:00.000Z",
  },
  {
    id: AgentProfileId.make("docs-reviewer"),
    scope: "project" as const,
    revision,
    name: "Docs Reviewer",
    description: "Checks README changes",
    defaultModelSelection: null,
    chatSelectable: false,
    sourcePath: null,
    requirements: { t3McpCapabilities: [], toolRequirement: "none" as const },
    archivedAt: null,
    updatedAt: "2026-08-07T12:00:00.000Z",
  },
];

describe("filterAgentProfiles", () => {
  it("searches names, ids, descriptions, and scopes", () => {
    expect(filterAgentProfiles(profiles, "planner")).toEqual([profiles[0]]);
    expect(filterAgentProfiles(profiles, "docs-reviewer")).toEqual([profiles[1]]);
    expect(filterAgentProfiles(profiles, "README project")).toEqual([profiles[1]]);
  });

  it("returns the catalog order for an empty query", () => {
    expect(filterAgentProfiles(profiles, "  ")).toBe(profiles);
  });

  it("offers only chat-selectable profiles while retaining a hidden current selection", () => {
    expect(selectChatAgentProfiles(profiles, null)).toEqual([profiles[0]]);
    expect(selectChatAgentProfiles(profiles, profiles[1]!)).toEqual(profiles);
  });

  it("retains a pinned profile by locator after its revision changes or it is archived", () => {
    const archived = {
      id: AgentProfileId.make("sol-planner"),
      scope: "environment",
      revision: AgentProfileRevision.make("b".repeat(64)),
      name: "Sol Planner",
      description: "Architecture and implementation plans",
      defaultModelSelection: null,
      chatSelectable: true,
      sourcePath: null,
      requirements: { t3McpCapabilities: [], toolRequirement: "none" },
      archivedAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    } satisfies AgentProfileSummary;
    expect(selectChatAgentProfiles([archived], profiles[0]!)).toEqual([archived]);
    expect(selectChatAgentProfiles([archived], null)).toEqual([]);
  });

  it("shows loading while a selected locator's catalog is still unavailable", () => {
    expect(agentProfilePickerLabel(null, profiles[0]!, true, false)).toBe("Loading agents…");
    expect(agentProfilePickerLabel(null, profiles[0]!, false, true)).toBe("Unavailable agent");
  });
});
