import { afterEach, describe, expect, it } from "vite-plus/test";

import { defaultIntakeProfile, loadIntakeProfiles, profileRoutingAliases } from "./profiles.ts";

const ORIGINAL_ENV = {
  T3_INTAKE_DEFAULT_PROFILE_ID: process.env.T3_INTAKE_DEFAULT_PROFILE_ID,
  T3_INTAKE_PROFILES_JSON: process.env.T3_INTAKE_PROFILES_JSON,
  SUPPORT_EMAIL_PROJECT_WORKSPACE_ROOT: process.env.SUPPORT_EMAIL_PROJECT_WORKSPACE_ROOT,
  SUPPORT_EMAIL_REPO_NAME: process.env.SUPPORT_EMAIL_REPO_NAME,
};

function resetProfileEnv() {
  for (const key of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearLegacySupportProfileEnv() {
  delete process.env.SUPPORT_EMAIL_PROJECT_WORKSPACE_ROOT;
  delete process.env.SUPPORT_EMAIL_REPO_NAME;
}

afterEach(() => {
  resetProfileEnv();
});

describe("defaultIntakeProfile", () => {
  it("uses T3_INTAKE_DEFAULT_PROFILE_ID when configured", () => {
    clearLegacySupportProfileEnv();
    process.env.T3_INTAKE_DEFAULT_PROFILE_ID = "nextcard";
    process.env.T3_INTAKE_PROFILES_JSON = JSON.stringify([
      { id: "docs", workspaceRoot: "~/code/docs", aliases: ["docs"] },
      { id: "nextcard", workspaceRoot: "~/code/nextcard", aliases: ["nextcard"] },
    ]);

    expect(defaultIntakeProfile(loadIntakeProfiles())?.id).toBe("nextcard");
  });

  it("uses the profile marked primary when no default id is configured", () => {
    clearLegacySupportProfileEnv();
    delete process.env.T3_INTAKE_DEFAULT_PROFILE_ID;
    process.env.T3_INTAKE_PROFILES_JSON = JSON.stringify([
      { id: "docs", workspaceRoot: "~/code/docs", aliases: ["docs"] },
      {
        id: "nextcard",
        workspaceRoot: "~/code/nextcard",
        aliases: ["nextcard"],
        primary: true,
      },
    ]);

    expect(defaultIntakeProfile(loadIntakeProfiles())?.id).toBe("nextcard");
  });

  it("rejects ambiguous primary profiles", () => {
    clearLegacySupportProfileEnv();
    delete process.env.T3_INTAKE_DEFAULT_PROFILE_ID;
    process.env.T3_INTAKE_PROFILES_JSON = JSON.stringify([
      { id: "docs", workspaceRoot: "~/code/docs", aliases: ["docs"], primary: true },
      { id: "nextcard", workspaceRoot: "~/code/nextcard", aliases: ["nextcard"], primary: true },
    ]);

    expect(() => defaultIntakeProfile(loadIntakeProfiles())).toThrow(
      "Only one intake profile can set primary: true.",
    );
  });
});

describe("loadIntakeProfiles", () => {
  it("normalizes Slack emoji names on intake profiles", () => {
    clearLegacySupportProfileEnv();
    process.env.T3_INTAKE_PROFILES_JSON = JSON.stringify([
      {
        id: "affil",
        workspaceRoot: "~/code/affil",
        aliases: ["affil"],
        slackEmoji: ":affil:",
      },
    ]);

    const profile = loadIntakeProfiles()[0];
    expect(profile?.slackEmoji).toBe("affil");
    expect(profile ? profileRoutingAliases(profile) : []).toEqual(["affil", ":affil:"]);
  });
});
