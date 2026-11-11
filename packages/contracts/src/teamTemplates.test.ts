import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  STARTER_TEAM_TEMPLATES,
  TeamTemplateDefinition,
  WORKSHOP_TEAM_TEMPLATE,
  teamTemplateById,
} from "./teamTemplates.ts";

const decodeTeamTemplate = Schema.decodeSync(TeamTemplateDefinition);

describe("teamTemplates", () => {
  it("decodes the Workshop starter team", () => {
    const decoded = decodeTeamTemplate(WORKSHOP_TEAM_TEMPLATE);
    expect(decoded.id).toBe("workshop");
    expect(decoded.seats.map((seat) => seat.id)).toEqual(["lead", "builder", "qa", "reviewer"]);
  });

  it("lists Workshop as the first starter team", () => {
    expect(STARTER_TEAM_TEMPLATES[0]?.id).toBe("workshop");
    expect(teamTemplateById("workshop").name).toBe("Workshop");
  });
});
