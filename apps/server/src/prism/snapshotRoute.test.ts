import { ProjectId, type ServerProvider, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makePrismSnapshot } from "./snapshotRoute.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

const provider = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-25T00:00:00.000Z",
  models: [{ slug: "gpt-5.6-luna", name: "Luna", isCustom: false, capabilities: null }],
  slashCommands: [{ name: "review" }],
  skills: [],
  usageLimits: {
    checkedAt: "2026-09-25T00:00:00.000Z",
    windows: [
      {
        id: "primary",
        kind: "session",
        label: "5h",
        usedPercent: 40,
        resetsAt: "2026-09-25T05:00:00.000Z",
      },
    ],
  },
} as unknown as ServerProvider;

describe("Prism provider snapshot", () => {
  const luna = [{ instanceId: "codex", model: "gpt-5.6-luna" }];
  const settings = decodeServerSettings({
    prismRoles: { worker: { lanes: { medium: luna, hard: luna } } },
    projectSettingsOverrides: {
      p1: { prismRoles: { reviewer: { lanes: { medium: luna } } } },
    },
  });

  it("carries models and usage windows with their reset times", () => {
    const snapshot = makePrismSnapshot({
      generatedAt: "2026-09-25T01:00:00.000Z",
      projectId: null,
      providers: [provider],
      settings,
    });
    expect(snapshot.providers).toEqual([
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        status: "ready",
        models: provider.models,
        usageLimits: provider.usageLimits,
      },
    ]);
    expect(snapshot.roles.worker.lanes).toEqual({ easy: [], medium: luna, hard: luna });
  });

  it("resolves role kits for a project over the environment", () => {
    const snapshot = makePrismSnapshot({
      generatedAt: "2026-09-25T01:00:00.000Z",
      projectId: ProjectId.make("p1"),
      providers: [],
      settings,
    });
    expect(snapshot.roles.reviewer.lanes.easy).toEqual(luna);
    expect(snapshot.roles.worker.lanes.medium).toEqual([]);
  });

  it("repeats a single list in every lane and flags only Retry and Escalation", () => {
    const snapshot = makePrismSnapshot({
      generatedAt: "2026-09-25T01:00:00.000Z",
      projectId: null,
      providers: [],
      settings: decodeServerSettings({
        prismRoles: {
          dispatcher: { models: luna },
          worker: { lanes: { hard: luna } },
          correction: { enabled: false },
        },
      }),
    });
    expect(snapshot.roles.dispatcher).toMatchObject({
      models: luna,
      lanes: { easy: luna, medium: luna, hard: luna },
    });
    expect(snapshot.roles.worker).not.toHaveProperty("models");
    expect(snapshot.roles.worker.lanes).toEqual({ easy: [], medium: [], hard: luna });
    expect(snapshot.roles.correction.enabled).toBe(false);
    expect(snapshot.roles.recovery.enabled).toBe(true);
    for (const role of ["planner", "dispatcher", "reviewer", "worker"] as const) {
      expect(snapshot.roles[role]).not.toHaveProperty("enabled");
    }
  });

  it("reports an unavailable instance as disabled", () => {
    const snapshot = makePrismSnapshot({
      generatedAt: "2026-09-25T01:00:00.000Z",
      projectId: null,
      providers: [{ ...provider, availability: "unavailable" }],
      settings,
    });
    expect(snapshot.providers[0]?.enabled).toBe(false);
  });
});
