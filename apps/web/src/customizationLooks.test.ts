import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  LookSettings,
  type SavedLook,
} from "@t3tools/contracts/settings";
import {
  assignLook,
  deleteLook,
  exportLook,
  importLook,
  lookProjectKeys,
  nextLookName,
  resolveLookSettings,
  resolveProjectLook,
  restoreLook,
  setLookProjects,
} from "./customizationLooks";

const decodeSettings = Schema.decodeSync(ClientSettingsSchema);
const look: SavedLook = {
  id: "ocean",
  name: "Ocean",
  settings: { ...Schema.decodeSync(LookSettings)({}), themeBackground: "ocean", chatWidth: "full" },
  theme: {
    "t3code:theme": "missing-custom-theme",
    "t3code:theme-appearance-mode": "dark",
    "t3code:theme-follow-system": null,
    "t3code:theme-halves:v1": null,
  },
};
const settings = {
  ...DEFAULT_CLIENT_SETTINGS,
  savedLooks: [look],
  projectLookAssignments: { alpha: look.id },
};

describe("project looks", () => {
  it("uses the assigned look and preserves unrelated device settings", () => {
    const result = resolveLookSettings({ ...settings, sendShortcut: "mod-enter" }, "alpha");
    expect(result.chatWidth).toBe("full");
    expect(result.themeBackground).toBe("ocean");
    expect(result.sendShortcut).toBe("mod-enter");
    expect(settings.chatWidth).toBe("comfortable");
  });
  it("inherits the default for unassigned, deleted, and missing projects", () => {
    expect(resolveLookSettings(settings, null)).toBe(settings);
    expect(resolveLookSettings(settings, "beta")).toBe(settings);
    const dangling = { ...settings, savedLooks: [] };
    expect(resolveLookSettings(dangling, "alpha")).toBe(dangling);
  });
  it("assigns and unassigns several projects without changing others", () => {
    const assigned = assignLook(settings, ["beta", "gamma"], look.id);
    expect(assigned.projectLookAssignments).toEqual({
      alpha: look.id,
      beta: look.id,
      gamma: look.id,
    });
    expect(assignLook(assigned, ["alpha", "beta"], null).projectLookAssignments).toEqual({
      gamma: look.id,
    });
    expect(settings.projectLookAssignments).toEqual({ alpha: look.id });
    expect(() => assignLook(settings, ["beta"], "missing")).toThrow();
  });
  it("removes all assignments when a look is deleted", () => {
    const result = deleteLook(assignLook(settings, ["beta"], look.id), look.id);
    expect(result.savedLooks).toEqual([]);
    expect(result.projectLookAssignments).toEqual({});
    expect(resolveProjectLook(result, "alpha")).toBeNull();
  });
  it("updates every assigned project when its saved look changes", () => {
    const changed = {
      ...assignLook(settings, ["beta"], look.id),
      savedLooks: [{ ...look, settings: { ...look.settings, glassOpacity: 50 } }],
    };
    expect(resolveLookSettings(changed, "alpha").glassOpacity).toBe(50);
    expect(resolveLookSettings(changed, "beta").glassOpacity).toBe(50);
    expect(resolveLookSettings(changed, "gamma").glassOpacity).toBe(
      DEFAULT_CLIENT_SETTINGS.glassOpacity,
    );
  });
});

describe("look sharing", () => {
  it("round trips appearance and layout without exporting ids or assignments", () => {
    const json = exportLook(look);
    expect(JSON.parse(json).id).toBeUndefined();
    expect(importLook(json, "fresh")).toEqual({ ...look, id: "fresh" });
    expect(
      decodeSettings({
        ...settings,
        savedLooks: [importLook(json, "fresh")],
      }).savedLooks,
    ).toHaveLength(1);
  });
  it("ignores unknown keys and does not allow unrelated settings into a look", () => {
    const input = JSON.parse(exportLook(look));
    input.future = true;
    input.settings.sendShortcut = false;
    input.settings.future = [];
    const imported = importLook(JSON.stringify(input), "new");
    expect(imported.settings).not.toHaveProperty("sendShortcut");
    expect(imported.settings).not.toHaveProperty("future");
  });
  it.each([
    { version: 2 },
    { name: " " },
    { settings: { chatWidth: false } },
    { settings: { glassOpacity: -1 } },
    { settings: { interfaceLayout: { chatHeader: { hidden: [42] } } } },
    { theme: { ...look.theme, "t3code:theme": {} } },
    { theme: { ...look.theme, "t3code:theme-appearance-mode": "invalid" } },
  ])("rejects invalid known fields: %j", (patch) => {
    expect(() =>
      importLook(JSON.stringify({ ...JSON.parse(exportLook(look)), ...patch }), "new"),
    ).toThrow();
  });
  it("old client settings decode with empty collections", () => {
    const decoded = decodeSettings({});
    expect(decoded.savedLooks).toEqual([]);
    expect(decoded.projectLookAssignments).toEqual({});
  });
  it("makes a look's projects exactly the chosen set, leaving other looks alone", () => {
    const other = { ...look, id: "forest", name: "Forest" };
    const start = {
      ...settings,
      savedLooks: [look, other],
      projectLookAssignments: { alpha: look.id, beta: look.id, gamma: other.id },
    };
    const next = setLookProjects(start, look.id, ["beta", "delta"]);
    expect(next.projectLookAssignments).toEqual({
      beta: look.id,
      gamma: other.id,
      delta: look.id,
    });
    expect(lookProjectKeys(next, look.id).toSorted()).toEqual(["beta", "delta"]);
  });
  it("undoes a delete in place with its projects, without stealing reassigned ones", () => {
    const other = { ...look, id: "forest", name: "Forest" };
    const start = {
      ...settings,
      savedLooks: [look, other],
      projectLookAssignments: { alpha: look.id, beta: look.id },
    };
    const deleted = assignLook(deleteLook(start, look.id), ["beta"], other.id);
    const restored = restoreLook(deleted, look, 0, ["alpha", "beta"]);
    expect(restored.savedLooks.map((entry) => entry.id)).toEqual([look.id, other.id]);
    expect(restored.projectLookAssignments).toEqual({ alpha: look.id, beta: other.id });
    expect(restoreLook(restored, look, 0, ["alpha"])).toBe(restored);
  });
  it("names new looks without repeating an existing name", () => {
    expect(nextLookName([])).toBe("Look 1");
    expect(nextLookName([{ ...look, name: "Look 2" }])).toBe("Look 3");
  });
});
