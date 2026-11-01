import { expect, it } from "vite-plus/test";

import type { DesktopDiscordPresence, DiscordPresenceField } from "@t3tools/contracts";

import {
  DEFAULT_DISCORD_PRESENCE_BRANDING,
  discordActivityForPresence,
  discordPresenceStateLine,
  resolveDiscordPresenceBranding,
  type DiscordPresenceBranding,
} from "./presenceActivity.ts";

const presence: DesktopDiscordPresence = {
  projectName: "t3code",
  modelLabel: "Claude Sonnet 4.5",
  workingThreads: 1,
  attentionThreads: 0,
};

const branding: DiscordPresenceBranding = {
  assetKey: "black",
  label: "T3 Code (Alpha)",
  version: "0.0.45",
};
const artwork = { large_image: "black", large_text: "T3 Code (Alpha) 0.0.45" };

const activityWith = (fields: ReadonlyArray<DiscordPresenceField>) =>
  discordActivityForPresence(presence, 1_700_000_000_000, fields, branding);

it("prefers running agents, then threads needing you, then idle", () => {
  expect(
    discordPresenceStateLine({
      projectName: null,
      modelLabel: null,
      workingThreads: 1,
      attentionThreads: 0,
    }),
  ).toBe("Running an agent");
  expect(
    discordPresenceStateLine({
      projectName: null,
      modelLabel: null,
      workingThreads: 3,
      attentionThreads: 2,
    }),
  ).toBe("Running 3 agents");
  expect(
    discordPresenceStateLine({
      projectName: null,
      modelLabel: null,
      workingThreads: 0,
      attentionThreads: 1,
    }),
  ).toBe("Waiting for you");
  expect(
    discordPresenceStateLine({
      projectName: null,
      modelLabel: null,
      workingThreads: 0,
      attentionThreads: 4,
    }),
  ).toBe("4 threads need you");
  expect(
    discordPresenceStateLine({
      projectName: null,
      modelLabel: null,
      workingThreads: 0,
      attentionThreads: 0,
    }),
  ).toBe("Idle");
});

it("presents project and activity by default", () => {
  expect(activityWith(["project", "activity"])).toEqual({
    details: "In t3code",
    state: "Running an agent",
    assets: artwork,
  });
});

it("joins the model with the activity line", () => {
  expect(activityWith(["project", "model", "activity"])).toEqual({
    details: "In t3code",
    state: "Claude Sonnet 4.5 · Running an agent",
    assets: artwork,
  });
});

it("omits the project line for a model-only selection", () => {
  const activity = activityWith(["model"]);
  expect(activity).toEqual({
    state: "Claude Sonnet 4.5",
    assets: artwork,
  });
  expect(activity.timestamps).toBeUndefined();
});

it("includes the elapsed timer only when selected", () => {
  expect(activityWith(["elapsed"]).timestamps).toEqual({ start: 1_700_000_000_000 });
  expect(activityWith([])).toEqual({ assets: artwork });
});

it("omits the project line when the project is unknown", () => {
  expect(
    discordActivityForPresence({ ...presence, projectName: null }, 0, ["project"], branding),
  ).toEqual({ assets: artwork });
});

it("omits the model token when only activity is selected or the label is unknown", () => {
  expect(activityWith(["project", "activity"]).state).toBe("Running an agent");
  expect(
    discordActivityForPresence(
      { ...presence, modelLabel: null },
      0,
      ["project", "model", "activity"],
      branding,
    ).state,
  ).toBe("Running an agent");
});

it("clamps long lines to Discord's limit", () => {
  const activity = discordActivityForPresence(
    {
      projectName: "x".repeat(64),
      modelLabel: "y".repeat(64),
      workingThreads: 0,
      attentionThreads: 0,
    },
    0,
    ["project", "model"],
    branding,
  );
  expect(activity.details!.length).toBeLessThanOrEqual(128);
  expect(activity.state!.length).toBeLessThanOrEqual(128);
});

it("maps the build stage to the uploaded art key and labels the version", () => {
  const stage = (stageLabel: "Dev" | "Nightly" | "Alpha") =>
    resolveDiscordPresenceBranding({
      branding: { baseName: "T3 Code", stageLabel, displayName: `T3 Code (${stageLabel})` },
      appVersion: stageLabel === "Nightly" ? "0.0.45-nightly.20261011" : "0.0.45",
    });

  expect(stage("Alpha")).toEqual({
    assetKey: "black",
    label: "T3 Code (Alpha)",
    version: "0.0.45",
  });
  expect(stage("Nightly")).toEqual({
    assetKey: "nightly",
    label: "T3 Code (Nightly)",
    version: "0.0.45-nightly.20261011",
  });
  expect(stage("Dev").assetKey).toBe("blueprint");
  expect(DEFAULT_DISCORD_PRESENCE_BRANDING.assetKey).toBe("black");
});
