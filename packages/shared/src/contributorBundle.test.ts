import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ContributorBundleFromJson,
  formatContributorBundleLeadPrompt,
  formatContributorBundleOrientation,
  parseContributorBundle,
} from "./contributorBundle.ts";

const decodeJson = Schema.decodeUnknownSync(ContributorBundleFromJson);

const workshopLike = {
  name: "Workshop contributors",
  description: "Lead, builder, QA, and reviewer with this repo's map.",
  orientation: {
    summary: "T3 Code is a GUI for coding agents.",
    map: [
      { path: "apps/server", purpose: "Orchestration and providers" },
      { path: "apps/web", purpose: "React UI" },
    ],
    guidance: "Run vp run check:changed before push.",
  },
  seats: [
    {
      id: "lead",
      title: "Workshop · Lead",
      roleBrief: "Own the outcome and coordinate seats.",
    },
    {
      id: "builder",
      title: "Workshop · Builder",
      roleBrief: "Implement assigned changes.",
    },
  ],
} as const;

describe("ContributorBundleFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // OSS contributor pack
      "name": "Workshop contributors",
      "orientation": {
        "summary": "Ship competence with the repo.",
        "map": [
          { "path": "apps/server", "purpose": "Server", },
        ],
      },
      "seats": [
        { "id": "lead", "title": "Lead", "roleBrief": "Coordinate.", },
      ],
    }`);

    expect(decoded.name).toBe("Workshop contributors");
    expect(decoded.orientation.map?.[0]).toEqual({
      path: "apps/server",
      purpose: "Server",
    });
    expect(decoded.seats).toHaveLength(1);
  });
});

describe("parseContributorBundle", () => {
  it("rejects a file with no seats", () => {
    expect(
      parseContributorBundle(`{
        "name": "Empty",
        "orientation": { "summary": "Nope" },
        "seats": []
      }`),
    ).toBeNull();
  });

  it("reads a Workshop-like contributor bundle", () => {
    expect(parseContributorBundle(JSON.stringify(workshopLike))).toEqual(workshopLike);
  });
});

describe("formatContributorBundleOrientation", () => {
  it("includes summary, map, and guidance", () => {
    expect(formatContributorBundleOrientation(workshopLike.orientation)).toContain(
      "apps/server: Orchestration and providers",
    );
    expect(formatContributorBundleOrientation(workshopLike.orientation)).toContain(
      "Run vp run check:changed before push.",
    );
  });
});

describe("formatContributorBundleLeadPrompt", () => {
  it("puts project orientation and specialist roster in the lead draft", () => {
    const prompt = formatContributorBundleLeadPrompt(workshopLike);
    expect(prompt).toContain("Project orientation");
    expect(prompt).toContain("Pinned teammates:");
    expect(prompt).toContain("Workshop · Builder");
    expect(prompt).toContain("apps/web: React UI");
  });
});
