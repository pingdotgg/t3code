import { describe, expect, it } from "vitest";

import {
  NOTES_SIDEBAR_DEFAULT_WIDTH_PX,
  NOTES_SIDEBAR_MAX_WIDTH_PX,
  NOTES_SIDEBAR_MIN_WIDTH_PX,
  clampNotesSidebarWidth,
  resizeNotesSidebarWidth,
  resolveNotesSidebarMaxWidth,
} from "./notesSidebarLayout";

describe("notesSidebarLayout", () => {
  it("keeps the default width within the supported bounds", () => {
    expect(NOTES_SIDEBAR_DEFAULT_WIDTH_PX).toBeGreaterThanOrEqual(NOTES_SIDEBAR_MIN_WIDTH_PX);
    expect(NOTES_SIDEBAR_DEFAULT_WIDTH_PX).toBeLessThanOrEqual(NOTES_SIDEBAR_MAX_WIDTH_PX);
  });

  it("caps the sidebar width using both viewport ratio and hard maximums", () => {
    expect(resolveNotesSidebarMaxWidth(480)).toBe(NOTES_SIDEBAR_MIN_WIDTH_PX);
    expect(resolveNotesSidebarMaxWidth(900)).toBe(495);
    expect(resolveNotesSidebarMaxWidth(2_000)).toBe(NOTES_SIDEBAR_MAX_WIDTH_PX);
  });

  it("clamps widths to the allowed range", () => {
    expect(clampNotesSidebarWidth(100, 1_200)).toBe(NOTES_SIDEBAR_MIN_WIDTH_PX);
    expect(clampNotesSidebarWidth(401.6, 1_200)).toBe(402);
    expect(clampNotesSidebarWidth(1_200, 800)).toBe(440);
  });

  it("grows when dragging the resize handle left and shrinks when dragging right", () => {
    expect(
      resizeNotesSidebarWidth({
        startWidth: NOTES_SIDEBAR_DEFAULT_WIDTH_PX,
        startClientX: 1_000,
        currentClientX: 920,
        viewportWidth: 1_440,
      }),
    ).toBe(420);
    expect(
      resizeNotesSidebarWidth({
        startWidth: NOTES_SIDEBAR_DEFAULT_WIDTH_PX,
        startClientX: 1_000,
        currentClientX: 1_060,
        viewportWidth: 1_440,
      }),
    ).toBe(NOTES_SIDEBAR_MIN_WIDTH_PX);
  });
});
