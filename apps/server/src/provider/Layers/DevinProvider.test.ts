import { describe, expect, it } from "vite-plus/test";

import { isDevinAuthenticatedOutput, parseDevinModels, parseDevinSkills } from "./DevinProvider.ts";

describe("isDevinAuthenticatedOutput", () => {
  it("does not mistake a negative status for an authenticated session", () => {
    expect(isDevinAuthenticatedOutput("Not logged in", 0)).toBe(false);
    expect(isDevinAuthenticatedOutput("Unauthenticated", 0)).toBe(false);
    expect(isDevinAuthenticatedOutput("Logged in", 0)).toBe(true);
    expect(isDevinAuthenticatedOutput("Authenticated", 2)).toBe(false);
  });
});

describe("parseDevinModels", () => {
  it("flattens every family variant and keeps the self-describing label as the name", () => {
    const models = parseDevinModels(
      JSON.stringify({
        families: [
          {
            family_label: "SWE 1.7",
            family_uid: "swe-1-7",
            slug: "swe-1-7",
            aliases: ["swe"],
            variants: [
              {
                model_uid: "swe-1-7-medium",
                label: "SWE 1.7 Medium",
                max_context_tokens: 200000,
                max_output_tokens: 64000,
                cost_tier: "medium",
                is_new: false,
                is_beta: false,
              },
              {
                model_uid: "swe-1-7-high",
                label: "SWE 1.7 High",
                max_context_tokens: 200000,
                max_output_tokens: 64000,
                cost_tier: "high",
                is_new: true,
                is_beta: true,
              },
            ],
          },
        ],
      }),
    );

    expect(models.map((model) => model.slug)).toEqual(["swe-1-7-medium", "swe-1-7-high"]);
    expect(models[0]).toMatchObject({
      name: "SWE 1.7 Medium",
      isDefault: true,
    });
    // No subProvider: the picker strips it from the name, which would leave
    // only the effort qualifier ("Medium") as the row title.
    expect(models[0]?.subProvider).toBeUndefined();
  });

  it("rejects malformed model output without throwing", () => {
    expect(parseDevinModels('{"families":"invalid"}')).toEqual([]);
  });
});

describe("parseDevinSkills", () => {
  it("exposes skills and user-triggered skills as slash commands", () => {
    const parsed = parseDevinSkills(
      JSON.stringify([
        {
          name: "review",
          description: "Review the current changes.",
          triggers: ["user", "model"],
          provider: "Devin",
          base_dir: "/tmp/skills/review",
          display_name: "Review",
          warnings: [],
          errors: [],
        },
        {
          name: "internal",
          triggers: ["model"],
          base_dir: "/tmp/skills/internal",
          warnings: [],
          errors: ["invalid skill"],
        },
        {
          name: "broken",
          description: "A user-triggered skill that failed validation.",
          triggers: ["user"],
          base_dir: "/tmp/skills/broken",
          warnings: [],
          errors: ["invalid skill"],
        },
      ]),
    );

    expect(parsed.skills).toHaveLength(3);
    expect(parsed.skills[0]).toMatchObject({
      name: "review",
      enabled: true,
      displayName: "Review",
    });
    expect(parsed.skills[1]?.enabled).toBe(false);
    // A disabled skill must not surface a selectable slash command, even with
    // a "user" trigger.
    expect(parsed.skills[2]?.enabled).toBe(false);
    expect(parsed.commands).toEqual([
      { name: "review", description: "Review the current changes." },
    ]);
  });
});
