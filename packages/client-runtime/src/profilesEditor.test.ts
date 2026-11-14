import type { ProfilesFile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deleteProfile,
  mcpServerNameError,
  parseJsonObject,
  profileNameError,
  promptUpserts,
  removeMcpServerRefs,
  renamePromptRefs,
  renameProfile,
  renameProviderSettings,
  renameProviderSettingsRefs,
  editDraft,
  settingsOptions,
  syncStatusText,
  toggleInList,
  viewDraft,
  withFeature,
  withKey,
} from "./profilesEditor.ts";

const file: ProfilesFile = {
  default: "work",
  profiles: {
    work: {
      prompts: ["base", "review"],
      skills: [],
      providerSettings: { claudeAgent: "lean", codex: "fast" },
      model: "opus",
    },
    home: { prompts: ["base"], skills: ["notes"], providerSettings: { claudeAgent: "lean" } },
  },
};

describe("profile edits", () => {
  it("renames a profile in place and follows the default", () => {
    const renamed = renameProfile(file, "work", "job");
    expect(Object.keys(renamed.profiles)).toEqual(["job", "home"]);
    expect(renamed.default).toBe("job");
    expect(renamed.profiles.job).toBe(file.profiles.work);
  });

  it("clears the default when deleting it", () => {
    expect(deleteProfile(file, "work")).toEqual({ profiles: { home: file.profiles.home } });
  });

  it("keeps prompt order when toggling, appending new ones", () => {
    expect(toggleInList(["b", "a"], "c", true)).toEqual(["b", "a", "c"]);
    expect(toggleInList(["b", "a", "c"], "a", false)).toEqual(["b", "c"]);
  });

  it.each([
    ["", "Enter a name."],
    ["-x", "Use letters, digits, - and _, starting with a letter or digit."],
    ["work", "That name is taken."],
    ["work-2", null],
  ])("checks the name %j", (name, expected) => {
    expect(profileNameError(name, ["work"])).toBe(expected);
  });
});

describe("references", () => {
  it("renames provider settings refs of one driver and keeps other keys", () => {
    const next = renameProviderSettingsRefs(file, "claudeAgent", "lean", "slim");
    expect(next.profiles.work).toEqual({
      ...file.profiles.work,
      providerSettings: { claudeAgent: "slim", codex: "fast" },
    });
    expect(next.profiles.home?.providerSettings).toEqual({ claudeAgent: "slim" });
  });

  it("drops a deleted provider settings ref, and the empty refs object with it", () => {
    const next = renameProviderSettingsRefs(file, "claudeAgent", "lean", null);
    expect(next.profiles.work?.providerSettings).toEqual({ codex: "fast" });
    expect(next.profiles.home).toEqual({ prompts: ["base"], skills: ["notes"] });
  });

  it("renames prompt refs in place and removes deleted ones", () => {
    expect(renamePromptRefs(file, "base", "core").profiles.work?.prompts).toEqual([
      "core",
      "review",
    ]);
    expect(renamePromptRefs(file, "base", null).profiles.home?.prompts).toEqual([]);
  });

  it("drops a deleted MCP server, and the empty list with it", () => {
    const withServers: ProfilesFile = {
      profiles: {
        work: { prompts: [], skills: [], mcpServers: ["docs", "local"] },
        home: { prompts: [], skills: [], mcpServers: ["docs"] },
      },
    };
    const next = removeMcpServerRefs(withServers, "docs");
    expect(next.profiles.work?.mcpServers).toEqual(["local"]);
    expect(next.profiles.home).toEqual({ prompts: [], skills: [] });
    expect(mcpServerNameError("T3-code-x", [])).toBe("Names starting with t3-code are T3's own.");
  });

  it("renames a named provider settings entry in place and removes empty drivers", () => {
    const settings = {
      claudeAgent: { lean: { chrome: true }, full: {} },
      pi: { quiet: { skills: false } },
    };
    expect(
      Object.keys(renameProviderSettings(settings, "claudeAgent", "lean", "slim").claudeAgent!),
    ).toEqual(["slim", "full"]);
    expect(renameProviderSettings(settings, "pi", "quiet", null)).toEqual({
      claudeAgent: settings.claudeAgent,
    });
  });
});

describe("provider settings forms", () => {
  it("maps feature tri-states onto overrides and leaves out an empty map", () => {
    const features = withFeature(undefined, "web_search", "on");
    expect(features).toEqual({ web_search: true });
    expect(withFeature(features, "apps", "off")).toEqual({ web_search: true, apps: false });
    expect(withFeature(features, "web_search", "default")).toBeUndefined();
  });

  it("lists detected names first and keeps stored names this machine did not report", () => {
    expect(
      settingsOptions([{ name: "Bash", enabled: true }, { name: "Read" }], ["WebFetch", "Bash"]),
    ).toEqual([
      { name: "Bash", enabled: true, detected: true },
      { name: "Read", detected: true },
      { name: "WebFetch", detected: false },
    ]);
    expect(settingsOptions([], ["Bash"], "Discovery failed")).toEqual([
      { name: "Bash", detected: true },
    ]);
    expect(settingsOptions([{ name: "Read" }], ["Bash"], "Discovery incomplete")).toEqual([
      { name: "Read", detected: true },
      { name: "Bash", detected: false },
    ]);
  });

  it.each([
    ["", { ok: true, value: undefined }],
    ["{}", { ok: true, value: undefined }],
    ['{"env": {"A": "1"}}', { ok: true, value: { env: { A: "1" } } }],
    ["[1]", { ok: false, error: 'Enter a JSON object, like { "key": true }.' }],
  ])("parses advanced JSON %j", (text, expected) => {
    expect(parseJsonObject(text)).toEqual(expected);
  });

  it("rejects broken advanced JSON", () => {
    expect(parseJsonObject("{").ok).toBe(false);
  });
});

it("writes only new or changed prompts", () => {
  expect(
    promptUpserts(
      [
        { name: "a", content: "1" },
        { name: "b", content: "2" },
      ],
      { a: "1", b: "3", c: "" },
    ),
  ).toEqual([
    { name: "b", content: "3" },
    { name: "c", content: "" },
  ]);
});

describe("section drafts", () => {
  it("follows the saved value until edited, then keeps the edit", () => {
    expect(viewDraft({ a: 1 }, null)).toEqual({ value: { a: 1 }, dirty: false, stale: false });
    const draft = editDraft({ a: 1 }, null, { a: 2 });
    expect(viewDraft({ a: 1 }, draft)).toEqual({ value: { a: 2 }, dirty: true, stale: false });
  });

  it("is stale when the saved value moved under an edit", () => {
    const draft = editDraft({ a: 1 }, null, { a: 2 });
    expect(viewDraft({ a: 3 }, draft).stale).toBe(true);
    // A further edit keeps the original base, so the conflict is not hidden.
    expect(editDraft({ a: 3 }, draft, { a: 4 }).base).toEqual({ a: 1 });
  });

  it("is clean again once the edit returns to its base", () => {
    const draft = editDraft({ a: 1 }, null, { a: 1 });
    expect(viewDraft({ a: 5 }, draft)).toEqual({ value: { a: 5 }, dirty: false, stale: false });
  });
});

it("keeps keys the form does not edit", () => {
  const entry = { chrome: true, settings: { env: { A: "1" } }, futureKey: 1 };
  expect(withKey(entry, "chrome", undefined)).toEqual({
    settings: { env: { A: "1" } },
    futureKey: 1,
  });
});

it.each([
  [{ connected: false, canWrite: true, status: undefined }, "Not connected"],
  [{ connected: true, canWrite: false, status: undefined }, "No permission to change settings"],
  [
    {
      connected: true,
      canWrite: true,
      status: { kind: "backup", revision: 3, at: "t", path: "/b" },
    },
    "Updated; its own changes were saved to /b",
  ],
  [
    { connected: true, canWrite: true, status: { kind: "failed", message: "disk full" } },
    "Failed: disk full",
  ],
] as const)("describes sync status %#", (input, text) => {
  expect(syncStatusText(input).text).toBe(text);
});
