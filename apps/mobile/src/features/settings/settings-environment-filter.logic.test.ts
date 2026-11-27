import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toggleSettingsEnvironment } from "./settings-environment-filter.logic";

describe("settings selection across disconnected environments", () => {
  const a = EnvironmentId.make("a");
  const b = EnvironmentId.make("b");
  const c = EnvironmentId.make("c");
  const d = EnvironmentId.make("d");
  const all = [a, b, c, d].map((environmentId) => ({ environmentId }));
  const connected = all.filter((entry) => entry.environmentId !== b);

  it.each([
    {
      name: "keeps offline environments selected from All",
      selected: null,
      toggles: [c],
      expected: [a, b, d],
    },
    {
      name: "keeps offline environments deselected after toggling off and on",
      selected: new Set([a, c, d]),
      toggles: [c, c],
      expected: [a, c, d],
    },
    {
      name: "ignores toggles of offline environments",
      selected: new Set([a]),
      toggles: [b],
      expected: [a],
    },
    {
      name: "returns to All when every known environment is selected",
      selected: new Set([a, b, d]),
      toggles: [c],
      expected: null,
    },
  ])("$name", ({ selected, toggles, expected }) => {
    let next: ReadonlySet<EnvironmentId> | null = selected;
    for (const id of toggles) {
      next = toggleSettingsEnvironment(next, connected, id, all);
    }
    expect(next).toEqual(expected === null ? null : new Set(expected));
  });
});
