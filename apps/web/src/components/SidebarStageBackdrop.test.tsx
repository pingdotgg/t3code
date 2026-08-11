import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  StageBackdropArt,
  StageBackdropButtonArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("resolves stage artwork only when enabled", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
  });

  it("matches the focus-ring offset to each artwork palette", () => {
    expect(resolveSidebarStageFocusRingOffsetClass("nightly")).toBe(
      "focus-visible:ring-offset-(--stage-night-bottom)",
    );
    expect(resolveSidebarStageFocusRingOffsetClass("dev")).toBe(
      "focus-visible:ring-offset-(--stage-art-bottom)",
    );
  });

  it.each(["nightly", "dev"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it("paints each artwork variant with theme-owned color tokens", () => {
    const nightlyMarkup = renderToStaticMarkup(<StageBackdropArt variant="nightly" />);
    const devMarkup = renderToStaticMarkup(<StageBackdropArt variant="dev" />);

    expect(nightlyMarkup).toContain("var(--stage-night-bottom)");
    expect(nightlyMarkup).toContain("var(--stage-night-line)");
    expect(devMarkup).toContain("var(--stage-art-bottom)");
    expect(devMarkup).toContain("var(--stage-art-line)");
    expect(nightlyMarkup).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(devMarkup).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it.each([
    ["nightly", "96 0 8192 96"],
    ["dev", "64 0 8192 96"],
  ] as const)("uses the compact %s crop inside the send button", (variant, viewBox) => {
    const markup = renderToStaticMarkup(<StageBackdropButtonArt variant={variant} />);

    expect(markup).toContain(`viewBox="${viewBox}"`);
    expect(markup).toContain(`stage-${variant === "dev" ? "blueprint" : "nightly"}`);
  });
});
