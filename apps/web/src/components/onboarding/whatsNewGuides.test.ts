import { describe, expect, it } from "vite-plus/test";

import { resolveWhatsNewGuides, whatsNewGuides } from "./whatsNewGuides";

describe("resolveWhatsNewGuides", () => {
  it("shows every guide to an existing install without a record", () => {
    const result = resolveWhatsNewGuides({
      seen: null,
      existingInstall: true,
      chatSyncAvailable: true,
    });
    expect(result.guides).toEqual(whatsNewGuides);
    expect(result.seed).toBeNull();
  });

  it("seeds a new install and shows no guides", () => {
    const result = resolveWhatsNewGuides({
      seen: null,
      existingInstall: false,
      chatSyncAvailable: true,
    });
    expect(result.guides).toEqual([]);
    expect(result.seed).toEqual(whatsNewGuides.map((guide) => guide.id));
  });

  it("returns only guides that have not been seen", () => {
    const result = resolveWhatsNewGuides({
      seen: ["new-lesson", "courses"],
      existingInstall: true,
      chatSyncAvailable: true,
    });
    expect(result.guides.map((guide) => guide.id)).toEqual([
      "side-chats",
      "what-you-know",
      "quiz-cards",
      "question-cards",
      "chat-sync",
    ]);
  });

  it("excludes chat sync when no environment supports it", () => {
    const result = resolveWhatsNewGuides({
      seen: [],
      existingInstall: true,
      chatSyncAvailable: false,
    });
    expect(result.guides.map((guide) => guide.id)).not.toContain("chat-sync");
  });
});
