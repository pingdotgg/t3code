import { describe, expect, it } from "vitest";
import { COMMIT_MODES, CUSTOM_COMMIT_TEMPLATES } from "./commitTemplates";

describe("commitTemplates", () => {
  describe("COMMIT_MODES", () => {
    it("should have all required commit modes", () => {
      expect(COMMIT_MODES).toHaveLength(4);
      const modeValues = COMMIT_MODES.map((mode) => mode.value);
      expect(modeValues).toContain("standard");
      expect(modeValues).toContain("auto");
      expect(modeValues).toContain("gitmoji");
      expect(modeValues).toContain("custom");
    });

    it("should have all required properties for each mode", () => {
      COMMIT_MODES.forEach((mode) => {
        expect(mode.label).toBeTruthy();
        expect(mode.summary).toBeTruthy();
        expect(mode.description).toBeTruthy();
        expect(mode.value).toMatch(/^(standard|auto|gitmoji|custom)$/);
      });
    });
  });

  describe("CUSTOM_COMMIT_TEMPLATES", () => {
    it("should have at least 3 predefined templates", () => {
      expect(CUSTOM_COMMIT_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    });

    it("should have required templates", () => {
      const templateIds = CUSTOM_COMMIT_TEMPLATES.map((t) => t.id);
      expect(templateIds).toContain("simple");
      expect(templateIds).toContain("standard");
      expect(templateIds).toContain("standard-ticket");
    });

    it("should have all required properties for each template", () => {
      CUSTOM_COMMIT_TEMPLATES.forEach((template) => {
        expect(template.id).toBeTruthy();
        expect(template.label).toBeTruthy();
        expect(template.prompt).toBeTruthy();
        expect(template.description).toBeTruthy();
        expect(template.example).toBeTruthy();
      });
    });

    it("should have unique template IDs", () => {
      const ids = CUSTOM_COMMIT_TEMPLATES.map((t) => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should include Conventional Commits format in standard template", () => {
      const standardTemplate = CUSTOM_COMMIT_TEMPLATES.find((t) => t.id === "standard");
      expect(standardTemplate).toBeDefined();
      expect(standardTemplate?.prompt).toContain("<type>");
      expect(standardTemplate?.prompt).toContain("<scope>");
      expect(standardTemplate?.prompt).toContain("<subject>");
    });

    it("should include ticket reference in standard-ticket template", () => {
      const ticketTemplate = CUSTOM_COMMIT_TEMPLATES.find((t) => t.id === "standard-ticket");
      expect(ticketTemplate).toBeDefined();
      expect(ticketTemplate?.prompt).toMatch(
        /ticket|ticket reference|issue reference|Refs:|PROJ-/i,
      );
    });
  });
});
