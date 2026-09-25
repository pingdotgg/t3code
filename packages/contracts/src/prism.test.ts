import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_PRISM_ROLE_KITS,
  PrismRoleKits,
  PrismRoleKitsPatch,
  PrismRoleName,
  prismRoleFromName,
} from "./prism.ts";
import { ProjectSettingsOverrides, ServerSettings } from "./settings.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeProjectOverrides = Schema.decodeSync(ProjectSettingsOverrides);
const decodeKitsPatch = Schema.decodeSync(PrismRoleKitsPatch);
const encodeKits = Schema.encodeSync(PrismRoleKits);
const decodeName = Schema.decodeUnknownSync(PrismRoleName);

describe("Prism role kits", () => {
  it("default each role to its thread-tool scope with no preferred models", () => {
    expect(DEFAULT_PRISM_ROLE_KITS.planner.threadTools).toBe("planner");
    expect(DEFAULT_PRISM_ROLE_KITS.dispatcher.threadTools).toBe("children");
    expect(DEFAULT_PRISM_ROLE_KITS.reviewer.threadTools).toBe("project-read");
    for (const role of ["worker", "correction", "recovery"] as const) {
      expect(DEFAULT_PRISM_ROLE_KITS[role].threadTools).toBe("none");
    }
    expect(DEFAULT_PRISM_ROLE_KITS.worker.lanes).toEqual({ easy: [], medium: [], hard: [] });
    expect(DEFAULT_PRISM_ROLE_KITS.dispatcher.models).toEqual([]);
    expect(DEFAULT_PRISM_ROLE_KITS.correction.enabled).toBe(true);
    expect(DEFAULT_PRISM_ROLE_KITS.recovery.enabled).toBe(true);
    expect("enabled" in DEFAULT_PRISM_ROLE_KITS.reviewer).toBe(false);
  });

  it("keep a saved per-lane list as the single list of a role other than the worker", () => {
    const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "high" };
    const luna = { instanceId: "codex", model: "gpt-5.6-luna" };
    const settings = decodeServerSettings({
      prismRoles: {
        dispatcher: { instructions: "Lead.", lanes: { easy: [luna], medium: [opus], hard: [] } },
        reviewer: { lanes: { hard: [opus] } },
        correction: { models: [luna], lanes: { medium: [opus] }, enabled: false },
      },
    });
    expect(settings.prismRoles.dispatcher.models).toEqual([opus]);
    expect(settings.prismRoles.dispatcher.instructions).toBe("Lead.");
    expect("lanes" in settings.prismRoles.dispatcher).toBe(false);
    expect(settings.prismRoles.reviewer.models).toEqual([]);
    expect(settings.prismRoles.correction).toMatchObject({ models: [luna], enabled: false });
    expect(encodeKits(settings.prismRoles).dispatcher).toEqual({
      instructions: "Lead.",
      skills: [],
      threadTools: "children",
      models: [opus],
    });
  });

  it("accept the shown names of renamed roles", () => {
    expect(prismRoleFromName(decodeName("retry"))).toBe("correction");
    expect(prismRoleFromName(decodeName("escalation"))).toBe("recovery");
    expect(prismRoleFromName(decodeName("recovery"))).toBe("recovery");
    expect(() => decodeName("fixer")).toThrow();
  });

  it("fill missing roles and fields when a settings file names one role", () => {
    const settings = decodeServerSettings({
      prismRoles: {
        worker: {
          lanes: {
            medium: [
              { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "medium" },
              { instanceId: "opencode", model: "opencode/muse", effort: "medium" },
            ],
            hard: [{ instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "xhigh" }],
          },
        },
      },
    });
    expect(settings.prismRoles.worker.lanes.medium.map((entry) => entry.model)).toEqual([
      "claude-opus-5-5",
      "opencode/muse",
    ]);
    expect(settings.prismRoles.worker.lanes.hard[0]?.effort).toBe("xhigh");
    expect(settings.prismRoles.worker.lanes.easy).toEqual([]);
    expect(settings.prismRoles.recovery.models).toEqual([]);
    expect(settings.prismRoles.worker.threadTools).toBe("none");
    expect(settings.prismRoles.reviewer.threadTools).toBe("project-read");
  });

  it("accept a project override of the whole kit set", () => {
    const overrides = decodeProjectOverrides({
      prismRoles: {
        reviewer: { models: [{ instanceId: "codex", model: "gpt-5.6-luna" }] },
      },
    });
    expect(overrides.prismRoles?.reviewer.models[0]?.model).toBe("gpt-5.6-luna");
    expect(overrides.prismRoles?.planner.threadTools).toBe("planner");
  });

  it("patch one lane of the worker or one field of another role without defaults", () => {
    expect(decodeKitsPatch({ worker: { lanes: { hard: [] } } })).toEqual({
      worker: { lanes: { hard: [] } },
    });
    expect(decodeKitsPatch({ recovery: { enabled: false } })).toEqual({
      recovery: { enabled: false },
    });
  });
});
