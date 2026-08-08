import { describe, expect, it } from "vite-plus/test";

import { countActiveDiscordPresenceProjects } from "./discordPresence";

const thread = (
  environmentId: string,
  projectId: string,
  options: {
    readonly status?: string;
    readonly backgroundLiveness?: "working" | "monitoring";
  } = {},
) => ({
  environmentId,
  projectId,
  session: options.status ? { status: options.status } : null,
  backgroundLiveness: options.backgroundLiveness ?? null,
});

describe("countActiveDiscordPresenceProjects", () => {
  it("deduplicates running threads in the same project", () => {
    expect(
      countActiveDiscordPresenceProjects([
        thread("local", "project-a", { status: "running" }),
        thread("local", "project-a", { status: "starting" }),
      ]),
    ).toBe(1);
  });

  it("keeps projects from different environments distinct", () => {
    expect(
      countActiveDiscordPresenceProjects([
        thread("local", "project-a", { status: "running" }),
        thread("remote", "project-a", { status: "running" }),
      ]),
    ).toBe(2);
  });

  it("counts background work but excludes monitoring and inactive threads", () => {
    expect(
      countActiveDiscordPresenceProjects([
        thread("local", "background", { backgroundLiveness: "working" }),
        thread("local", "monitoring", { backgroundLiveness: "monitoring" }),
        thread("local", "waiting"),
        thread("local", "failed", { status: "error" }),
      ]),
    ).toBe(1);
  });
});
