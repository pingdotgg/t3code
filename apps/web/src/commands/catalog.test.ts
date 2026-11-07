import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allStaticCommandContributions,
  defaultCommandTitle,
  staticCommandContribution,
} from "./catalog";

describe("command catalog", () => {
  it("contributes every static keybinding command", () => {
    const contributions = allStaticCommandContributions();
    expect(contributions.map((entry) => entry.id)).toEqual([...STATIC_KEYBINDING_COMMANDS]);
    for (const command of STATIC_KEYBINDING_COMMANDS) {
      const contribution = staticCommandContribution(command);
      expect(contribution?.id).toBe(command);
      expect(contribution?.title.length).toBeGreaterThan(0);
      expect(contribution?.searchTerms.length).toBeGreaterThan(0);
      expect(defaultCommandTitle(command)).toBe(contribution?.title);
    }
  });

  it("hides only the command palette toggle from the palette", () => {
    const hidden = allStaticCommandContributions().filter((entry) => entry.palette === false);
    expect(hidden.map((entry) => entry.id)).toEqual(["commandPalette.toggle"]);
  });
});
