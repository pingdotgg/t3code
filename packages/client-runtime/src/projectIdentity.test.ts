import { describe, expect, it } from "vite-plus/test";
import { ProjectIconColor } from "@t3tools/contracts";
import { deriveProjectIdentity } from "./projectIdentity.ts";

describe("deriveProjectIdentity", () => {
  it.each([
    ["Nebula", "NA"],
    ["Silver Orchard", "SO"],
    ["Quiet Lantern Workshop", "QW"],
    ["m7forge", "M7"],
    ["M7 Forge", "M7"],
    ["X", "XX"],
    ["---", "PR"],
  ])("derives %s as %s", (projectName, expected) => {
    expect(deriveProjectIdentity(projectName).monogram).toBe(expected);
  });

  it("keeps the palette stable across case and surrounding whitespace", () => {
    const canonical = deriveProjectIdentity("Nebula");
    const equivalent = deriveProjectIdentity("  NEBULA  ");

    expect(equivalent.color).toBe(canonical.color);
  });

  it("uses only assignable icon colors", () => {
    const palette: ReadonlyArray<string> = ProjectIconColor.literals;
    for (const name of ["Jobs", "Scripts and Extractors", "T3", "文書", "", "---"]) {
      expect(palette).toContain(deriveProjectIdentity(name).color);
    }
  });

  it("generates different hues for different project names", () => {
    const colors = new Set(
      ["Nebula", "M7 Forge", "Silver Orchard", "Blue Harbor", "Copper Finch", "Juniper Vale"].map(
        (projectName) => deriveProjectIdentity(projectName).color,
      ),
    );

    expect(colors.size).toBeGreaterThan(1);
  });
});
