// @effect-diagnostics nodeBuiltinImport:off -- Verifies the bundled skill matches the repository's discoverable SKILL.md.
import * as NodeFS from "node:fs";
import { it, expect } from "vite-plus/test";
import {
  EXTENSION_DEVELOPMENT_SKILL,
  EXTENSION_DEVELOPMENT_REFERENCE,
} from "./extensionDevelopmentSkill.ts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "./orchestrationInstructions.ts";

it("ships the discoverable skill and advertises when agents must load it", () => {
  expect(EXTENSION_DEVELOPMENT_SKILL).toBe(
    NodeFS.readFileSync(
      new URL("../../../../.agents/skills/t3-extension-development/SKILL.md", import.meta.url),
      "utf8",
    ),
  );
  expect(EXTENSION_DEVELOPMENT_REFERENCE).toBe(
    NodeFS.readFileSync(new URL("../../../../docs/extensions.md", import.meta.url), "utf8"),
  );
  const reference = EXTENSION_DEVELOPMENT_SKILL.match(/\]\((references\/[^)]+)\)/)?.[1];
  if (!reference) throw new Error("The skill must link to its installed developer guide.");
  expect(
    NodeFS.readFileSync(
      new URL(`../../../../.agents/skills/t3-extension-development/${reference}`, import.meta.url),
      "utf8",
    ),
  ).toBe(EXTENSION_DEVELOPMENT_REFERENCE);
  expect(EXTENSION_DEVELOPMENT_SKILL).toMatch(
    /^---\nname: t3-extension-development\ndescription: Use when /,
  );
  expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).toContain(
    "Before building or modifying a T3 extension, load t3-extension-development via extensions_development.",
  );
});
