import { describe, expect, it } from "vite-plus/test";

import {
  INTERFACE_SURFACES,
  moveSurfaceElement,
  resolveSurfaceLayout,
  setSurfaceElementHidden,
} from "../../interfaceLayout";
import {
  applyPresetLayout,
  matchPreset,
  PRESETS,
  resolvePresetPreview,
  surfaceVisibility,
} from "./customizePresets";

const preset = (id: string) => PRESETS.find((candidate) => candidate.id === id)!;

describe("matchPreset", () => {
  it("recognises every preset from its own choices", () => {
    for (const candidate of PRESETS) expect(matchPreset(candidate.settings)).toBe(candidate.id);
  });

  it("ignores ordering and chat width when the preset does not decide them", () => {
    const layout = moveSurfaceElement(
      preset("balanced").settings.interfaceLayout,
      "chatHeader",
      "git",
      "scripts",
    );
    const wide = { interfaceLayout: layout, chatWidth: "wide" as const };
    const full = { interfaceLayout: layout, chatWidth: "full" as const };
    expect(matchPreset(wide)).toBe("balanced");
    expect(matchPreset(full)).toBe("balanced");
  });

  it("reports custom visibility and distinguishes Focus from Minimal", () => {
    const layout = setSurfaceElementHidden({}, "chatHeader", "git", true);
    expect(matchPreset({ interfaceLayout: layout })).toBeNull();
    expect(matchPreset(preset("focus").settings)).toBe("focus");
    expect(matchPreset(preset("minimal").settings)).toBe("minimal");
    expect(surfaceVisibility("chatHeader", preset("focus").settings.interfaceLayout).shown).toBe(0);
    expect(
      surfaceVisibility("composerContextBar", preset("focus").settings.interfaceLayout).shown,
    ).toBe(1);
  });
});

describe("applyPresetLayout", () => {
  it("returns the saved layout unchanged when the visibility already matches", () => {
    for (const candidate of PRESETS) {
      const current = moveSurfaceElement(
        candidate.settings.interfaceLayout,
        "chatHeader",
        "git",
        "scripts",
      );
      expect(applyPresetLayout(current, candidate.settings.interfaceLayout)).toBe(current);
    }
  });
  it("changes visibility while preserving ordering on every surface", () => {
    const current = {
      threadRow: {
        order: ["provider", "environment", "pullRequest", "terminal", "branch"],
        hidden: ["status"],
      },
      chatHeader: { order: ["git", "openIn", "scripts"], hidden: ["git"] },
      composerToolbar: { order: ["mode", "traits"], hidden: ["attach"] },
      composerContextBar: { order: ["branch", "controls", "workspace"], hidden: ["workspace"] },
    };
    for (const candidate of PRESETS) {
      const next = applyPresetLayout(current, candidate.settings.interfaceLayout);
      for (const surface of [
        "threadRow",
        "chatHeader",
        "composerToolbar",
        "composerContextBar",
      ] as const) {
        expect(next[surface]?.order).toEqual(current[surface].order);
        expect(resolveSurfaceLayout(surface, next).hidden).toEqual(
          resolveSurfaceLayout(surface, candidate.settings.interfaceLayout).hidden,
        );
      }
      expect(matchPreset({ ...candidate.settings, interfaceLayout: next })).toBe(candidate.id);
    }
    expect(current.chatHeader.hidden).toEqual(["git"]);
  });

  it("keeps unknown surfaces, element ordering and visibility from a newer build", () => {
    const current = {
      chatHeader: {
        order: ["future-action", "git", "openIn", "scripts"],
        hidden: ["future-action", "git"],
      },
      futureSurface: { order: ["future-detail"], hidden: ["future-detail"] },
    };
    const next = applyPresetLayout(current, preset("balanced").settings.interfaceLayout);
    expect(next.chatHeader).toEqual({ order: current.chatHeader.order, hidden: ["future-action"] });
    expect(next.futureSurface).toBe(current.futureSurface);
    expect(current.chatHeader.hidden).toEqual(["future-action", "git"]);
  });

  it("restores details without resetting custom order", () => {
    const current = setSurfaceElementHidden(
      moveSurfaceElement({}, "chatHeader", "git", "scripts"),
      "chatHeader",
      "openIn",
      true,
    );
    const next = applyPresetLayout(current, preset("balanced").settings.interfaceLayout);
    expect(resolveSurfaceLayout("chatHeader", next).order).toEqual(
      resolveSurfaceLayout("chatHeader", current).order,
    );
    expect(resolveSurfaceLayout("chatHeader", next).hidden.size).toBe(0);
  });

  it("never hides required controls", () => {
    const layout = applyPresetLayout({}, preset("focus").settings.interfaceLayout);
    for (const surface of [
      "threadRow",
      "chatHeader",
      "composerToolbar",
      "composerContextBar",
    ] as const) {
      const hidden = resolveSurfaceLayout(surface, layout).hidden;
      for (const element of INTERFACE_SURFACES[surface]) {
        if ("required" in element && element.required) expect(hidden.has(element.id)).toBe(false);
      }
    }
  });
});

describe("resolvePresetPreview", () => {
  it("preserves meter preferences and chat width for every preset", () => {
    for (const meter of [false, true]) {
      for (const candidate of PRESETS) {
        expect(resolvePresetPreview("contextWindowMeterEnabled", meter, candidate.id)).toBe(meter);
        expect(resolvePresetPreview("chatWidth", "wide", candidate.id)).toBe("wide");
        expect(candidate.settings).not.toHaveProperty("contextWindowMeterEnabled");
        expect(candidate.settings).not.toHaveProperty("chatWidth");
      }
    }
  });

  it("previews visibility without persisting or reordering the saved layout", () => {
    const current = moveSurfaceElement({}, "chatHeader", "git", "scripts");
    const before = structuredClone(current);
    const next = resolvePresetPreview("interfaceLayout", current, "focus");
    expect(resolveSurfaceLayout("chatHeader", next).hidden.size).toBe(3);
    expect(resolveSurfaceLayout("chatHeader", next).order).toEqual(
      resolveSurfaceLayout("chatHeader", current).order,
    );
    expect(current).toEqual(before);
    expect(resolvePresetPreview("interfaceLayout", current, null)).toBe(current);
    expect(resolvePresetPreview("chatWidth", "wide", null)).toBe("wide");
    expect(resolvePresetPreview("contextWindowMeterEnabled", true, null)).toBe(true);
  });
});

describe("surfaceVisibility", () => {
  it("counts hidden elements against the surface total", () => {
    const layout = setSurfaceElementHidden({}, "chatHeader", "git", true);
    expect(surfaceVisibility("chatHeader", layout)).toEqual({ shown: 2, total: 3 });
  });
});
