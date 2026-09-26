import { describe, expect, it } from "vite-plus/test";

import { moveSurfaceElement, setSurfaceElementHidden } from "../../interfaceLayout";
import { resolvePresetPreview, matchPreset, PRESETS, surfaceVisibility } from "./customizePresets";

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

describe("resolvePresetPreview", () => {
  it("uses every preset value only while the mode is active", () => {
    const current = { ...preset("balanced").settings, chatWidth: "wide" as const };
    for (const candidate of PRESETS) {
      for (const key of ["interfaceLayout", "chatWidth", "contextWindowMeterEnabled"] as const) {
        expect(resolvePresetPreview(key, current[key], true, candidate.id)).toBe(
          candidate.settings[key],
        );
        expect(resolvePresetPreview(key, current[key], false, candidate.id)).toBe(current[key]);
        expect(resolvePresetPreview(key, current[key], true, null)).toBe(current[key]);
      }
    }
    expect(current.chatWidth).toBe("wide");
    expect(current.interfaceLayout).toEqual({});
  });
});

describe("surfaceVisibility", () => {
  it("counts hidden elements against the surface total", () => {
    const layout = setSurfaceElementHidden({}, "chatHeader", "git", true);
    expect(surfaceVisibility("chatHeader", layout)).toEqual({ shown: 2, total: 3 });
  });
});
