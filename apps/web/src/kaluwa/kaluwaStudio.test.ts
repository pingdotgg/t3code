import { describe, expect, it } from "vite-plus/test";

import { createVividThemeColors, toCanonicalThemeColor } from "../themePalette";
import { DEFAULT_KALUWA_LOOK } from "./kaluwaLook";
import { KALUWA_PRESETS } from "./kaluwaPalette";
import {
  createStudioTheme,
  designFromPreset,
  effectiveSchemeColors,
  parseStudioFile,
  parseStudioLibrary,
  serializeStudioFile,
  serializeStudioLibrary,
  studioPreset,
  studioThemeDefinition,
  studioThemeId,
  uniqueStudioName,
} from "./kaluwaStudio";
import { designForTheme, normalizeStudioSettings } from "./kaluwaStudioActions";

const BUILDERS = { generate: createVividThemeColors, canonical: toCanonicalThemeColor };

const settings = {
  look: { ...DEFAULT_KALUWA_LOOK, mood: "jewel", statusSwatches: { working: "lagoon" } },
  tabs: { enabled: true, style: "folder", radius: 10, height: 34, openIn: "new-tab" },
  backdrop: { art: "waves", opacity: 70 },
  sidebar: { kaluwaSidebarSubagents: "chip" },
};

describe("theme studio designs", () => {
  it("starts a built-in's copy from exactly its colours", () => {
    const design = designFromPreset("ember");
    expect(effectiveSchemeColors(design, "dark")).toEqual(KALUWA_PRESETS.ember.dark);
    expect(effectiveSchemeColors(design, "light")).toEqual(KALUWA_PRESETS.ember.light);
    expect(designForTheme("kaluwa-ember")).toEqual(design);
    expect(designForTheme(null)).toEqual(designFromPreset("today"));
  });

  it("applies warmth and contrast the way the lab did", () => {
    const design = { ...designFromPreset("noir"), warmth: 100, contrast: -50 };
    const colors = effectiveSchemeColors(design, "dark");
    // Pure black warmed 9% toward ember orange.
    expect(colors.bg).toBe("#170d06");
    expect(colors.accent).toBe(KALUWA_PRESETS.noir.dark.accent);
    expect(colors.borderAlpha).toBeLessThan(KALUWA_PRESETS.noir.dark.borderAlpha);
  });

  it("forks a built-in into a new theme without touching the preset", () => {
    const before = structuredClone(KALUWA_PRESETS.ember);
    const fork = createStudioTheme(
      { name: "Ember (edited)", design: designForTheme("kaluwa-ember"), settings },
      [],
    );
    expect(fork.id).toBe("kaluwa-studio-ember-edited");
    const edited = { ...fork, design: { ...fork.design, radius: 20, warmth: 40 } };
    expect(studioPreset(edited).radius).toBe(20);
    expect(KALUWA_PRESETS.ember).toEqual(before);
  });

  it("keeps names and ids unique", () => {
    expect(uniqueStudioName("Dusk", ["dusk", "Dusk 2"])).toBe("Dusk 3");
    expect(studioThemeId("Dusk!", ["kaluwa-studio-dusk"])).toBe("kaluwa-studio-dusk-2");
    expect(studioThemeId("කළුවා", [])).toBe("kaluwa-studio-theme");
  });
});

describe("theme studio files", () => {
  it("round-trips a captured theme through JSON into an app theme", () => {
    const theme = createStudioTheme(
      { name: "Night ride", design: { ...designFromPreset("tide"), radius: 18 }, settings },
      [],
    );
    const parsed = parseStudioFile(serializeStudioFile(theme));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.name).toBe("Night ride");
    expect(parsed.file.design).toEqual(theme.design);
    expect(parsed.file.settings).toEqual(settings);

    const imported = createStudioTheme(
      { name: parsed.file.name, design: parsed.file.design, settings: parsed.file.settings ?? {} },
      [theme],
    );
    expect(imported.name).toBe("Night ride 2");
    const definition = studioThemeDefinition(imported, BUILDERS);
    expect(definition.id).toBe(imported.id);
    expect(definition.label).toBe("Night ride 2");
    expect(definition.appearance).toBe("dark");
    expect(definition.colors.canvas).toBe(toCanonicalThemeColor(KALUWA_PRESETS.tide.dark.bg));
    expect(definition.variants?.light?.canvas).toBe(
      toCanonicalThemeColor(KALUWA_PRESETS.tide.light.bg),
    );

    const restored = normalizeStudioSettings(imported.settings);
    expect(restored.look?.mood).toBe("jewel");
    expect(restored.look?.statusSwatches).toEqual({ working: "lagoon" });
    expect(restored.tabs?.style).toBe("folder");
    expect(restored.backdrop?.art).toBe("waves");
    expect(restored.backdrop?.cell).toBe(4);
    expect(restored.sidebar).toEqual({ kaluwaSidebarSubagents: "chip" });
  });

  it("rejects what isn't a valid theme", () => {
    const good = JSON.parse(
      serializeStudioFile({ name: "Ok", design: designFromPreset("paper"), settings: {} }),
    );
    const reason = (text: string) => {
      const result = parseStudioFile(text);
      return result.ok ? "ok" : result.reason;
    };
    expect(reason(JSON.stringify(good))).toBe("ok");
    expect(reason("  ")).toBe("empty");
    expect(reason("{nope")).toBe("json");
    expect(reason("[]")).toBe("kind");
    expect(reason(JSON.stringify({ ...good, kind: "vscode-theme" }))).toBe("kind");
    expect(reason(JSON.stringify({ ...good, version: 2 }))).toBe("version");
    expect(reason(JSON.stringify({ ...good, design: { ...good.design, radius: 99 } }))).toBe(
      "invalid",
    );
    expect(
      reason(
        JSON.stringify({
          ...good,
          design: { ...good.design, dark: { ...good.design.dark, bg: "black" } },
        }),
      ),
    ).toBe("invalid");
    const { font: _font, ...withoutFont } = good.design;
    expect(reason(JSON.stringify({ ...good, design: withoutFont }))).toBe("invalid");
    expect(reason(JSON.stringify({ ...good, name: "   " }))).toBe("invalid");
    expect(
      reason(JSON.stringify({ ...good, image: { name: "x", dataUrl: "javascript:alert(1)" } })),
    ).toBe("invalid");
  });

  it("drops stored entries that no longer validate", () => {
    const theme = createStudioTheme(
      { name: "Keep", design: designFromPreset("ember"), settings },
      [],
    );
    const raw = JSON.parse(serializeStudioLibrary([theme]));
    raw.themes.push({ ...theme }, { ...theme, id: "kaluwa-studio-bad", design: {} }, 42);
    expect(parseStudioLibrary(JSON.stringify(raw))).toEqual([theme]);
    expect(parseStudioLibrary("{broken")).toEqual([]);
  });
});
