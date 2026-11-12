import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { AgentTeam, AgentTeamId } from "./agentTeam.ts";

const decodeAgentTeam = Schema.decodeSync(AgentTeam);

describe("agentTeam", () => {
  it("decodes a persisted agent team", () => {
    const decoded = decodeAgentTeam({
      id: AgentTeamId.make("agent-team:workshop"),
      projectId: ProjectId.make("project:demo"),
      name: "Workshop",
      installedFrom: { kind: "builtin", templateId: "workshop" },
      seatKeys: ["lead", "builder", "qa", "reviewer"],
      leadKey: "lead",
      archivedAt: null,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    expect(decoded.name).toBe("Workshop");
    expect(decoded.seatKeys).toEqual(["lead", "builder", "qa", "reviewer"]);
  });
});
