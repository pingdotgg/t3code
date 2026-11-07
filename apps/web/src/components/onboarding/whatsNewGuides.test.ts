import { describe, expect, it } from "vite-plus/test";

import { resolveWhatsNewGuides, whatsNewGuides } from "./whatsNewGuides";

const allIds = whatsNewGuides.map((guide) => guide.id);

describe("resolveWhatsNewGuides", () => {
  it.each([
    ["no record at all", { seen: null, legacySeen: null, legacyInstall: false }],
    // Before the fix, profiles without the v1 welcome key were seeded as new installs on first launch.
    [
      "a v1 record seeded on an install without the v1 welcome key",
      { seen: null, legacySeen: allIds, legacyInstall: false },
    ],
  ])("shows every guide for %s", (_name, records) => {
    const result = resolveWhatsNewGuides({ ...records, chatSyncAvailable: true });
    expect(result.guides).toEqual(whatsNewGuides);
  });

  it("keeps v1 dismissals from installs that had the v1 welcome key", () => {
    const result = resolveWhatsNewGuides({
      seen: null,
      legacySeen: ["new-lesson", "courses"],
      legacyInstall: true,
      chatSyncAvailable: true,
    });
    expect(result.seen).toEqual(["new-lesson", "courses"]);
    expect(result.guides.map((guide) => guide.id)).toEqual([
      "side-chats",
      "what-you-know",
      "quiz-cards",
      "question-cards",
      "chat-sync",
    ]);
  });

  it("returns only guides missing from the current record", () => {
    const result = resolveWhatsNewGuides({
      seen: allIds.filter((id) => id !== "courses"),
      legacySeen: [],
      legacyInstall: true,
      chatSyncAvailable: true,
    });
    expect(result.guides.map((guide) => guide.id)).toEqual(["courses"]);
  });

  it("excludes chat sync when no environment supports it", () => {
    const result = resolveWhatsNewGuides({
      seen: [],
      legacySeen: null,
      legacyInstall: false,
      chatSyncAvailable: false,
    });
    expect(result.guides.map((guide) => guide.id)).not.toContain("chat-sync");
  });
});
