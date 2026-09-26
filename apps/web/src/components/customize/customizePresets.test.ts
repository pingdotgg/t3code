import { describe, expect, it } from "vite-plus/test";

import { moveSurfaceElement, setSurfaceElementHidden } from "../../interfaceLayout";
import { elementsPresetHides, matchPreset, PRESETS, surfaceVisibility } from "./customizePresets";

const preset = (id: string) => PRESETS.find((candidate) => candidate.id === id)!;

describe("matchPreset", () => {
  it("recognises every preset from its own settings", () => {
    for (const candidate of PRESETS) expect(matchPreset(candidate.settings)).toBe(candidate.id);
  });

  it("reports a custom arrangement once anything differs", () => {
    const balanced = preset("balanced").settings;
    expect(
      matchPreset({
        ...balanced,
        interfaceLayout: moveSurfaceElement({}, "chatHeader", "git", "scripts"),
      }),
    ).toBeNull();
    expect(matchPreset({ ...balanced, chatWidth: "wide" })).toBeNull();
  });
});

describe("elementsPresetHides", () => {
  it("lists only elements that are showing now", () => {
    const current = setSurfaceElementHidden({}, "threadRow", "project", true);
    expect(elementsPresetHides(preset("minimal"), current)).toEqual([
      "threadRow:branch",
      "threadRow:terminal",
      "threadRow:environment",
      "composerToolbar:traits",
      "chatHeader:scripts",
    ]);
  });

  it("hides nothing for the standard layout", () => {
    expect(elementsPresetHides(preset("balanced"), {})).toEqual([]);
  });
});

describe("surfaceVisibility", () => {
  it("counts hidden elements against the surface total", () => {
    const layout = setSurfaceElementHidden({}, "chatHeader", "git", true);
    expect(surfaceVisibility("chatHeader", layout)).toEqual({ shown: 2, total: 3 });
  });
});
