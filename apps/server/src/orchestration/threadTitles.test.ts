import { expect, it } from "vite-plus/test";

import { canReplaceThreadTitle, forkThreadTitle, DEFAULT_THREAD_TITLE } from "./threadTitles.ts";

it("only replaces known auto-generated thread titles", () => {
  expect(canReplaceThreadTitle(DEFAULT_THREAD_TITLE)).toBe(true);
  expect(canReplaceThreadTitle("Fork: Parent thread")).toBe(false);
  expect(canReplaceThreadTitle("Side chat: Parent thread")).toBe(false);
  expect(canReplaceThreadTitle("A deliberate title")).toBe(false);
});

it("numbers forks after their source like the Codex app", () => {
  const plain = { sourceIsFork: false };
  const fork = { sourceIsFork: true };
  expect(forkThreadTitle("Fix the parser", [], plain)).toBe("Fix the parser (1)");
  expect(forkThreadTitle("Fix the parser", ["Fix the parser (1)"], plain)).toBe(
    "Fix the parser (2)",
  );
  // Forking a fork counts from the shared base, and gaps left by renames or
  // deletions are reused.
  expect(forkThreadTitle("Fix the parser (2)", ["Fix the parser (2)"], fork)).toBe(
    "Fix the parser (1)",
  );
  // A user's own parenthetical is not a fork suffix.
  expect(forkThreadTitle("Release (2024)", [], plain)).toBe("Release (2024) (1)");
  expect(forkThreadTitle("  ", [], plain)).toBe("New thread (1)");
});
