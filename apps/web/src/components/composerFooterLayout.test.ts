import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX,
  measureComposerFooterOverflowPx,
  resolveComposerFooterContentWidth,
  shouldForceCompactComposerFooterForFit,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";

describe("shouldUseCompactComposerFooter", () => {
  it("stays expanded without a measured width", () => {
    expect(shouldUseCompactComposerFooter(null)).toBe(false);
  });

  it("switches to compact mode below the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX - 1)).toBe(true);
  });

  it("stays expanded at and above the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX)).toBe(false);
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX + 48)).toBe(false);
  });

  it("uses a higher breakpoint for wide action states", () => {
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});

describe("shouldUseCompactComposerPrimaryActions", () => {
  it("matches the wide footer breakpoint", () => {
    expect(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX).toBe(
      COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
    );
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});

describe("measureComposerFooterOverflowPx", () => {
  it("returns the overflow amount when content exceeds the footer width", () => {
    expect(
      measureComposerFooterOverflowPx({
        footerContentWidth: 500,
        leadingContentWidth: 340,
        actionsWidth: 180,
      }),
    ).toBe(28);
  });

  it("returns zero when content fits", () => {
    expect(
      measureComposerFooterOverflowPx({
        footerContentWidth: 500,
        leadingContentWidth: 320,
        actionsWidth: 160,
      }),
    ).toBe(0);
  });
});

describe("shouldForceCompactComposerFooterForFit", () => {
  it("stays expanded when content widths fit within the footer", () => {
    expect(
      shouldForceCompactComposerFooterForFit({
        footerContentWidth: 500,
        leadingContentWidth: 320,
        actionsWidth: 160,
      }),
    ).toBe(false);
  });

  it("stays expanded when minor overflow can be recovered by compacting primary actions", () => {
    expect(
      shouldForceCompactComposerFooterForFit({
        footerContentWidth: 500,
        leadingContentWidth: 340,
        actionsWidth: 180,
      }),
    ).toBe(false);
  });

  it("forces footer compact mode when action compaction would not recover enough space", () => {
    expect(
      shouldForceCompactComposerFooterForFit({
        footerContentWidth: 500,
        leadingContentWidth: 420,
        actionsWidth: 220,
      }),
    ).toBe(true);
  });

  it("ignores incomplete measurements", () => {
    expect(
      shouldForceCompactComposerFooterForFit({
        footerContentWidth: null,
        leadingContentWidth: 340,
        actionsWidth: 180,
      }),
    ).toBe(false);
  });
});

describe("resolveComposerFooterContentWidth", () => {
  it("subtracts horizontal padding from the measured footer width", () => {
    expect(
      resolveComposerFooterContentWidth({
        footerWidth: 500,
        paddingLeft: 10,
        paddingRight: 10,
      }),
    ).toBe(480);
  });

  it("clamps negative widths to zero", () => {
    expect(
      resolveComposerFooterContentWidth({
        footerWidth: 10,
        paddingLeft: 8,
        paddingRight: 8,
      }),
    ).toBe(0);
  });

  it("returns null when measurements are incomplete", () => {
    expect(
      resolveComposerFooterContentWidth({
        footerWidth: null,
        paddingLeft: 8,
        paddingRight: 8,
      }),
    ).toBeNull();
  });
});
